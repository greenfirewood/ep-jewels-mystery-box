#!/usr/bin/env node
/**
 * Rebalance Lariat-Letter-Necklace and Classic-CZ-Letter-Charm budgets.
 *
 * The migration to mb_remaining left each letter variant with its old
 * per-variant mb_cap (75 and 50), but the original spec was 75 / 50 TOTAL
 * across A-Z. This script redistributes so the total budget per product
 * matches the original spec.
 *
 * Default: Lariat -> 3 per letter (~78 total), Charm -> 2 per letter (~52 total).
 * Override with --lariat-each=N --charm-each=N.
 *
 * Usage:
 *   node rebalance-letter-budgets.js --dry
 *   node rebalance-letter-budgets.js
 *   node rebalance-letter-budgets.js --lariat-each=4 --charm-each=2
 */
const STORE = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
if (!STORE || !TOKEN) { console.error('Need SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN'); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (k, d) => {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? parseInt(a.split('=')[1], 10) : d;
};
const LARIAT_EACH = flag('lariat-each', 3);
const CHARM_EACH = flag('charm-each', 2);

const TARGETS = [
  { handle: 'lariat-letter-necklace',    each: LARIAT_EACH },
  { handle: 'classic-cz-letter-cuff-charm', each: CHARM_EACH },
];

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('graphql: ' + JSON.stringify(j.errors));
  return j;
}

(async () => {
  for (const t of TARGETS) {
    const res = await gql(`{
      productByHandle(handle: "${t.handle}") {
        id title
        variants(first: 100) { edges { node { id sku } } }
      }
    }`);
    const p = res.data.productByHandle;
    if (!p) { console.log(`SKIP ${t.handle} (not found)`); continue; }
    console.log(`\n${p.title} (${t.handle}) -> ${t.each} per variant × ${p.variants.edges.length} = ${t.each * p.variants.edges.length} total`);

    for (const v of p.variants.edges) {
      if (DRY) {
        console.log(`  [dry] ${v.node.sku.padEnd(30)} mb_remaining := ${t.each}`);
        continue;
      }
      const r = await gql(`
        mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message code }
          }
        }
      `, {
        metafields: [{
          ownerId: v.node.id,
          namespace: 'custom',
          key: 'mb_remaining',
          type: 'number_integer',
          value: String(t.each),
        }],
      });
      const errs = r.data.metafieldsSet.userErrors || [];
      if (errs.length) {
        console.error(`  FAIL ${v.node.sku}:`, errs);
      } else {
        console.log(`  ${v.node.sku.padEnd(30)} mb_remaining = ${t.each}`);
      }
    }
  }
})();
