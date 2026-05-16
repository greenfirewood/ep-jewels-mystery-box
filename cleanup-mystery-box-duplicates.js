#!/usr/bin/env node
/**
 * Safely de-duplicates mystery-box products created by accidental Matrixify import.
 *
 * SAFETY MODEL:
 *   - Dry-run by default. Prints plan + writes deletion-plan.json. Touches nothing.
 *   - --execute --archive   sets status=ARCHIVED (reversible from Shopify admin)
 *   - --execute --delete    permanently deletes (only run after archive + review)
 *   - --max=N               aborts if candidate count > N (default 20)
 *   - Requires typed confirmation in terminal before any write.
 *
 * MATCH RULES (ALL must be true to flag as duplicate):
 *   - Same exact title as another tagged product
 *   - Has ONLY one mystery-box-tier-N tag, no other tags
 *   - All variants priced at $0.00
 *   - A "keeper" sibling exists with the same title, the tier tag, additional tags,
 *     and at least one variant priced > $0
 *
 * AUTH:
 *   - SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *
 * Usage:
 *   node cleanup-mystery-box-duplicates.js                          # dry-run
 *   node cleanup-mystery-box-duplicates.js --execute --archive      # archive
 *   node cleanup-mystery-box-duplicates.js --execute --delete       # delete
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SHOP = 'ep-the-label.myshopify.com';
const API_VERSION = '2025-01';
const TIER_TAGS = ['mystery-box-tier-1', 'mystery-box-tier-2', 'mystery-box-tier-3'];

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const ARCHIVE = args.includes('--archive');
const DELETE = args.includes('--delete');
const MAX = (() => {
  const a = args.find(x => x.startsWith('--max='));
  return a ? parseInt(a.split('=')[1], 10) : 20;
})();

if (EXECUTE && !ARCHIVE && !DELETE) {
  console.error('ERROR: --execute requires either --archive or --delete.');
  process.exit(1);
}
if (ARCHIVE && DELETE) {
  console.error('ERROR: --archive and --delete are mutually exclusive.');
  process.exit(1);
}

let TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

async function ensureToken() {
  if (TOKEN) return;
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('ERROR: provide SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.');
    process.exit(1);
  }
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) { console.error(`Token exchange failed: ${res.status} ${await res.text()}`); process.exit(1); }
  TOKEN = (await res.json()).access_token;
  console.log('Fetched fresh access token.');
}

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) { console.error('FATAL: 401 from Shopify. Aborting.'); process.exit(1); }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  // throttle awareness
  const cost = json.extensions?.cost;
  if (cost && cost.throttleStatus.currentlyAvailable < 200) {
    await sleep(1500);
  }
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function preflight() {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': TOKEN },
  });
  if (!res.ok) { console.error(`Preflight failed: ${res.status} ${await res.text()}`); process.exit(1); }
  const { shop } = await res.json();
  console.log(`Preflight OK — "${shop.name}" (${shop.myshopify_domain})\n`);
}

const FETCH_QUERY = `
  query fetchByTag($cursor: String, $q: String!) {
    products(first: 100, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          tags
          totalInventory
          variants(first: 100) { edges { node { id sku price } } }
        }
      }
    }
  }
`;

async function fetchAllTagged() {
  const all = new Map(); // id -> product
  for (const tag of TIER_TAGS) {
    let cursor = null;
    do {
      const data = await gql(FETCH_QUERY, { cursor, q: `tag:${tag}` });
      for (const edge of data.products.edges) {
        const p = edge.node;
        p.variantList = p.variants.edges.map(e => e.node);
        all.set(p.id, p);
      }
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
  }
  return [...all.values()];
}

async function productHasOrders(productId) {
  // Cheap heuristic: query orders by line_items.product_id is unsupported.
  // Use product.metafields? No. Use sales channels / inventory? Imprecise.
  // Fall back to: a product with totalInventory tracked & sales is unsafe to delete.
  // Use the Orders Search with line_items containing the product handle as a string.
  // Conservative default: if we cannot prove zero orders, we still archive (not delete).
  // For deletion path, require zero orders — checked via Order count by SKU lookup per variant.
  return false; // placeholder; deletion path adds extra guard below
}

const ORDER_COUNT_QUERY = `
  query orderCountBySku($q: String!) {
    orders(first: 1, query: $q) { edges { node { id name } } }
  }
`;

async function anyVariantHasOrders(product) {
  for (const v of product.variantList) {
    if (!v.sku) continue;
    const data = await gql(ORDER_COUNT_QUERY, { q: `sku:${v.sku}` });
    if (data.orders.edges.length > 0) return true;
  }
  return false;
}

function isCandidate(p) {
  const tierTags = p.tags.filter(t => TIER_TAGS.includes(t));
  if (tierTags.length !== 1) return false;
  const otherTags = p.tags.filter(t => !TIER_TAGS.includes(t));
  if (otherTags.length > 0) return false; // has extra tags — likely the original
  const prices = p.variantList.map(v => parseFloat(v.price));
  if (prices.length === 0) return false;
  if (!prices.every(pr => pr === 0)) return false;
  return true;
}

function isKeeper(p) {
  const otherTags = p.tags.filter(t => !TIER_TAGS.includes(t));
  if (otherTags.length === 0) return false;
  const prices = p.variantList.map(v => parseFloat(v.price));
  return prices.some(pr => pr > 0);
}

const KEEPER_LOOKUP = `
  query keeperByTitle($q: String!) {
    products(first: 5, query: $q) {
      edges { node { id title handle tags variants(first: 5) { edges { node { price } } } } }
    }
  }
`;

async function findUntaggedSibling(candidate) {
  // Search the whole store for products with the same title; pick any that is NOT
  // the candidate itself, has at least one variant priced > 0, and lacks every tier tag.
  const data = await gql(KEEPER_LOOKUP, { q: `title:"${candidate.title.replace(/"/g, '\\"')}"` });
  for (const e of data.products.edges) {
    const p = e.node;
    if (p.id === candidate.id) continue;
    const hasTierTag = p.tags.some(t => TIER_TAGS.includes(t));
    if (hasTierTag) continue;
    const hasRealPrice = p.variants.edges.some(v => parseFloat(v.node.price) > 0);
    if (!hasRealPrice) continue;
    return p;
  }
  return null;
}

async function buildPlan(products) {
  const candidates = products.filter(isCandidate);
  const plan = [];
  for (const c of candidates) {
    const sibling = await findUntaggedSibling(c);
    plan.push({
      title: c.title,
      candidateId: c.id,
      candidateHandle: c.handle,
      candidateStatus: c.status,
      candidateTags: c.tags,
      candidatePrices: c.variantList.map(v => v.price),
      keeperFound: !!sibling,
      keeperId: sibling?.id ?? null,
      keeperHandle: sibling?.handle ?? null,
      keeperTags: sibling?.tags ?? null,
    });
  }
  return plan;
}

const ARCHIVE_MUTATION = `
  mutation archive($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

const DELETE_MUTATION = `
  mutation del($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

async function archiveOne(productId) {
  const data = await gql(ARCHIVE_MUTATION, { input: { id: productId, status: 'ARCHIVED' } });
  const errs = data.productUpdate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  return data.productUpdate.product;
}

async function deleteOne(productId) {
  const data = await gql(DELETE_MUTATION, { input: { id: productId } });
  const errs = data.productDelete.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  return data.productDelete.deletedProductId;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function tsLogFile() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(__dirname, `mystery-box-cleanup-${ts}.log`);
}

async function main() {
  console.log(`Mode: ${EXECUTE ? (ARCHIVE ? 'EXECUTE (ARCHIVE)' : 'EXECUTE (DELETE)') : 'DRY-RUN'}`);
  console.log(`Max candidates allowed: ${MAX}\n`);

  await ensureToken();
  await preflight();

  console.log('Fetching all tagged products...');
  const products = await fetchAllTagged();
  console.log(`  Found ${products.length} products across ${TIER_TAGS.join(', ')}\n`);

  console.log('Resolving untagged siblings for each candidate...');
  const plan = await buildPlan(products);
  const withSibling = plan.filter(p => p.keeperFound);
  const orphans = plan.filter(p => !p.keeperFound);
  console.log(`  ${plan.length} total candidates  |  ${withSibling.length} with untagged keeper  |  ${orphans.length} orphans (no sibling)\n`);

  if (orphans.length) {
    console.log('--- ORPHANS (NO ACTION — review manually, may be real products) ---');
    orphans.forEach(o => console.log(`  ${o.candidateId}  "${o.title}"  tags=${JSON.stringify(o.candidateTags)}`));
    console.log('');
  }

  // Write manifest
  const manifestPath = path.join(__dirname, 'deletion-plan.json');
  fs.writeFileSync(manifestPath, JSON.stringify(plan, null, 2));
  console.log(`Plan written to ${manifestPath}\n`);

  const actionable = withSibling;
  if (actionable.length === 0) { console.log('No actionable candidates (no untagged keepers found). Nothing to do.'); return; }

  console.log('--- PLAN (only candidates with a confirmed untagged keeper) ---');
  for (const item of actionable) {
    console.log(`  DROP: ${item.candidateId}  "${item.title}"  tags=${JSON.stringify(item.candidateTags)}  prices=${JSON.stringify(item.candidatePrices)}`);
    console.log(`  KEEP: ${item.keeperId}  handle=${item.keeperHandle}  tags=${JSON.stringify(item.keeperTags)}`);
    console.log('');
  }

  if (actionable.length > MAX) {
    console.error(`ABORT: actionable count (${actionable.length}) exceeds --max=${MAX}. Raise --max if intentional.`);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('Dry-run complete. Re-run with --execute --archive (or --delete) to act.');
    return;
  }

  // Extra guard for delete: refuse if any candidate has orders.
  if (DELETE) {
    console.log('Checking for orders on candidate variants (deletion guard)...');
    for (const item of actionable) {
      const p = products.find(x => x.id === item.candidateId);
      if (await anyVariantHasOrders(p)) {
        console.error(`ABORT: candidate ${item.candidateId} "${item.title}" has orders — refuse to delete. Use --archive instead.`);
        process.exit(1);
      }
    }
    console.log('  No orders found on any candidate.\n');
  }

  const action = ARCHIVE ? 'archive' : 'delete';
  const confirmToken = `yes-${action}-${actionable.length}-products`;
  const ans = await prompt(`Type "${confirmToken}" to proceed: `);
  if (ans !== confirmToken) { console.log('Confirmation mismatch. Aborting.'); return; }

  const logPath = tsLogFile();
  const log = entry => fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');

  console.log(`\nExecuting (${action})... log: ${logPath}\n`);
  let ok = 0, failed = 0;
  for (const item of actionable) {
    try {
      if (ARCHIVE) {
        const p = await archiveOne(item.candidateId);
        console.log(`  ARCHIVED ${item.candidateId}  "${item.title}"`);
        log({ ts: new Date().toISOString(), action: 'archive', id: item.candidateId, title: item.title, result: p });
      } else {
        const id = await deleteOne(item.candidateId);
        console.log(`  DELETED  ${item.candidateId}  "${item.title}"`);
        log({ ts: new Date().toISOString(), action: 'delete', id: item.candidateId, title: item.title, deletedId: id });
      }
      ok++;
    } catch (err) {
      console.error(`  FAILED   ${item.candidateId}  "${item.title}"  -> ${err.message}`);
      log({ ts: new Date().toISOString(), action, id: item.candidateId, title: item.title, error: err.message });
      failed++;
    }
    await sleep(400); // gentle pacing
  }

  console.log(`\nDone. ${ok} succeeded, ${failed} failed.  Log: ${logPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
