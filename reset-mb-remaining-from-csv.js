#!/usr/bin/env node
/**
 * Reset mb_remaining for every spec'd SKU back to its original cap value
 * defined in the tier CSVs (mystery-box-tier-1-clean.csv, tier-2-clean,
 * tier-3-clean).
 *
 * Reads the cap from the CSV's "Metafield: custom.mb_cap [integer]" column
 * and writes that value to the variant's custom.mb_remaining metafield in
 * Shopify. Idempotent — re-running just refreshes everything to the spec.
 *
 * Usage:
 *   node reset-mb-remaining-from-csv.js --dry    # preview
 *   node reset-mb-remaining-from-csv.js          # actually write
 */
const fs = require('fs');
const path = require('path');
const STORE = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
if (!STORE || !TOKEN) { console.error('Need SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN'); process.exit(1); }
const DRY = process.argv.includes('--dry');

function parseCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function loadSpec() {
  const spec = []; // { sku, cap }
  for (const tier of ['1', '2', '3']) {
    const file = path.join(__dirname, `mystery-box-tier-${tier}-clean.csv`);
    if (!fs.existsSync(file)) continue;
    const rows = parseCsv(file);
    const header = rows[0];
    const skuIdx = header.findIndex(h => /Variant SKU/i.test(h));
    const capIdx = header.findIndex(h => /mb_cap/i.test(h));
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const sku = (r[skuIdx] || '').trim();
      const cap = parseInt((r[capIdx] || '').trim(), 10);
      if (sku && cap > 0) spec.push({ sku, cap, tier });
    }
  }
  return spec;
}

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

async function findVariantBySku(sku) {
  const res = await gql(`
    query($q: String!) {
      productVariants(first: 5, query: $q) {
        edges { node { id sku } }
      }
    }
  `, { q: `sku:${sku}` });
  const edges = res.data.productVariants.edges;
  const match = edges.find(e => e.node.sku === sku);
  return match?.node?.id || null;
}

(async () => {
  const spec = loadSpec();
  console.log(`Loaded ${spec.length} spec entries from CSVs\n`);

  let ok = 0, miss = 0, fail = 0;
  for (const { sku, cap, tier } of spec) {
    const variantId = await findVariantBySku(sku);
    if (!variantId) {
      console.log(`MISS  ${sku.padEnd(40)} not in Shopify`);
      miss++;
      continue;
    }
    if (DRY) {
      console.log(`[dry] ${sku.padEnd(40)} -> mb_remaining=${cap}`);
      ok++;
      continue;
    }
    const res = await gql(`
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }
    `, {
      metafields: [{
        ownerId: variantId,
        namespace: 'custom',
        key: 'mb_remaining',
        type: 'number_integer',
        value: String(cap),
      }],
    });
    const errs = res.data.metafieldsSet.userErrors || [];
    if (errs.length) {
      console.error(`FAIL  ${sku.padEnd(40)} ${JSON.stringify(errs)}`);
      fail++;
    } else {
      console.log(`OK    ${sku.padEnd(40)} mb_remaining=${cap} (tier ${tier})`);
      ok++;
    }
  }
  console.log(`\nDone. OK: ${ok}, MISS: ${miss}, FAIL: ${fail}`);
})();
