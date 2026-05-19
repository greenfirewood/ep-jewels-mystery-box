#!/usr/bin/env node
/**
 * Migrate from (mb_cap + mb_used) to single mb_remaining metafield.
 *
 * 1. Creates the mb_remaining variant metafield definition if missing.
 * 2. Iterates all variants that have mb_cap, computes
 *    mb_remaining = max(0, mb_cap - mb_used), and writes it.
 *
 * Idempotent — re-running just refreshes mb_remaining to the latest computed value.
 * Does NOT delete the legacy mb_cap / mb_used data — that stays on the variants
 * for safety. The engine will switch to reading mb_remaining only.
 *
 * Usage: node migrate-to-mb-remaining.js [--dry]
 */
const STORE = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
if (!STORE || !TOKEN) {
  console.error('Need SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}
const DRY = process.argv.includes('--dry');

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) {
    console.error('GraphQL errors:', JSON.stringify(j.errors, null, 2));
    throw new Error('graphql');
  }
  return j;
}

async function ensureDefinition() {
  const check = await gql(`{
    metafieldDefinitions(first: 50, ownerType: PRODUCTVARIANT, namespace: "custom") {
      edges { node { key } }
    }
  }`);
  const exists = check.data.metafieldDefinitions.edges.some(e => e.node.key === 'mb_remaining');
  if (exists) {
    console.log('definition custom.mb_remaining already exists');
    return;
  }
  if (DRY) {
    console.log('[dry] would create definition custom.mb_remaining');
    return;
  }
  const res = await gql(`
    mutation($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id key }
        userErrors { field message code }
      }
    }
  `, {
    definition: {
      name: 'Mystery Box Remaining',
      namespace: 'custom',
      key: 'mb_remaining',
      description: 'How many more mystery boxes this variant can be assigned to. Engine decrements automatically; client can raise to allocate more.',
      type: 'number_integer',
      ownerType: 'PRODUCTVARIANT',
    },
  });
  const errs = res.data.metafieldDefinitionCreate.userErrors || [];
  if (errs.length) throw new Error('create def: ' + JSON.stringify(errs));
  console.log('created definition custom.mb_remaining');
}

async function* iterateMysteryBoxVariants() {
  for (const tag of ['mystery-box-tier-1', 'mystery-box-tier-2', 'mystery-box-tier-3']) {
    let cursor = null;
    while (true) {
      const res = await gql(`
        query($cursor: String) {
          products(first: 100, after: $cursor, query: "tag:${tag}") {
            pageInfo { hasNextPage endCursor }
            edges { node { id title variants(first: 100) { edges { node { id sku
              metafields(first: 10, namespace: "custom") { edges { node { id key value } } }
            } } } } }
          }
        }
      `, { cursor });
      for (const p of res.data.products.edges) {
        for (const v of p.node.variants.edges) {
          const mf = Object.fromEntries(v.node.metafields.edges.map(e => [e.node.key, e.node.value]));
          yield { variantId: v.node.id, sku: v.node.sku || '', tier: tag, metafields: mf };
        }
      }
      if (!res.data.products.pageInfo.hasNextPage) break;
      cursor = res.data.products.pageInfo.endCursor;
    }
  }
}

(async () => {
  await ensureDefinition();

  let scanned = 0, updated = 0, skipped = 0;
  const seenVariants = new Set();

  for await (const v of iterateMysteryBoxVariants()) {
    if (seenVariants.has(v.variantId)) continue; // dedupe across tag overlaps
    seenVariants.add(v.variantId);
    scanned++;
    const cap = v.metafields.mb_cap ? parseInt(v.metafields.mb_cap, 10) : null;
    const used = v.metafields.mb_used ? parseInt(v.metafields.mb_used, 10) : 0;
    if (cap === null) {
      skipped++;
      continue;
    }
    const remaining = Math.max(0, cap - used);

    if (DRY) {
      console.log(`[dry] ${v.sku.padEnd(35)} cap=${cap} used=${used} -> mb_remaining=${remaining}`);
      updated++;
      continue;
    }

    const res = await gql(`
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message code }
        }
      }
    `, {
      metafields: [{
        ownerId: v.variantId,
        namespace: 'custom',
        key: 'mb_remaining',
        type: 'number_integer',
        value: String(remaining),
      }],
    });
    const errs = res.data.metafieldsSet.userErrors || [];
    if (errs.length) {
      console.error(`FAIL ${v.sku}: ${JSON.stringify(errs)}`);
      continue;
    }
    console.log(`${v.sku.padEnd(35)} cap=${cap} used=${used} -> mb_remaining=${remaining}`);
    updated++;
  }

  console.log(`\nScanned: ${scanned}  Updated: ${updated}  Skipped (no mb_cap): ${skipped}`);
})();
