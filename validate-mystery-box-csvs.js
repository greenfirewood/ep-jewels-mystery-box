#!/usr/bin/env node
/**
 * Validates Matrixify CSVs against the live Shopify store before import.
 *
 * Usage:
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxx node validate-mystery-box-csvs.js
 *
 * Requires Node 18+ (built-in fetch). No npm deps.
 */

const fs = require('fs');
const path = require('path');

const SHOP = 'ep-the-label.myshopify.com';
const API_VERSION = '2025-01';
const BATCH_SIZE = 50;

const TIERS = [
  { name: 'tier-1', input: 'mystery-box-tier-1.csv', output: 'mystery-box-tier-1-clean.csv' },
  { name: 'tier-2', input: 'mystery-box-tier-2.csv', output: 'mystery-box-tier-2-clean.csv' },
  { name: 'tier-3', input: 'mystery-box-tier-3.csv', output: 'mystery-box-tier-3-clean.csv' },
];

// Token resolution:
//   1. SHOPIFY_ACCESS_TOKEN (use directly if set)
//   2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (fetch fresh shpat_ via client_credentials)
let TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

async function ensureToken() {
  if (TOKEN) return TOKEN;
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
  if (!res.ok) {
    console.error(`ERROR: token exchange failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const { access_token } = await res.json();
  if (!access_token) { console.error('ERROR: token response missing access_token.'); process.exit(1); }
  TOKEN = access_token;
  console.log('Fetched fresh access token via client_credentials.');
  return TOKEN;
}

async function preflight() {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': TOKEN },
  });
  if (res.status === 401) {
    console.error('ERROR: preflight 401 — token rejected by Shopify. Aborting.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`ERROR: preflight HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const { shop } = await res.json();
  console.log(`Preflight OK — connected to "${shop.name}" (${shop.myshopify_domain}).`);
}

// --- Minimal CSV parser/writer that handles quoted fields with embedded quotes ---
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  const header = rows.shift();
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== '')).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCSV(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

// --- Shopify GraphQL ---
async function graphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    console.error('\nFATAL: 401 from Shopify mid-run. Token rejected. Aborting.');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const SKU_QUERY = `
  query findBySku($q: String!) {
    productVariants(first: 5, query: $q) {
      edges {
        node {
          sku
          id
          product { id handle title }
        }
      }
    }
  }
`;

const HANDLE_QUERY = `
  query findByHandle($handle: String!) {
    productByHandle(handle: $handle) { id handle title variants(first: 100) { edges { node { sku } } } }
  }
`;

async function checkSkuBatch(skus) {
  // Shopify query syntax: sku:'A' OR sku:'B'. Run per-sku in parallel within batch.
  const results = {};
  await Promise.all(skus.map(async sku => {
    try {
      const data = await graphql(SKU_QUERY, { q: `sku:'${sku.replace(/'/g, "\\'")}'` });
      const match = data.productVariants.edges.find(e => e.node.sku === sku);
      results[sku] = match ? {
        productId: match.node.product.id,
        productHandle: match.node.product.handle,
        productTitle: match.node.product.title,
      } : null;
    } catch (err) {
      console.error(`  query failed for SKU ${sku}: ${err.message}`);
      results[sku] = null;
    }
  }));
  return results;
}

async function checkHandle(handle) {
  try {
    const data = await graphql(HANDLE_QUERY, { handle });
    if (!data.productByHandle) return null;
    return {
      productId: data.productByHandle.id,
      title: data.productByHandle.title,
      skus: data.productByHandle.variants.edges.map(e => e.node.sku).filter(Boolean),
    };
  } catch (err) {
    console.error(`  handle query failed for ${handle}: ${err.message}`);
    return null;
  }
}

async function main() {
  await ensureToken();
  await preflight();
  const baseDir = __dirname;
  const allRows = {}; // tier -> { header, rows }
  const allSkus = new Set();

  for (const t of TIERS) {
    const filePath = path.join(baseDir, t.input);
    const text = fs.readFileSync(filePath, 'utf8');
    const rows = parseCSV(text);
    const header = Object.keys(rows[0]);
    allRows[t.name] = { header, rows, def: t };
    for (const r of rows) if (r['Variant SKU']) allSkus.add(r['Variant SKU']);
  }

  const skuList = [...allSkus];
  console.log(`\nChecking ${skuList.length} unique SKUs against ${SHOP}...\n`);

  const skuResults = {};
  for (let i = 0; i < skuList.length; i += BATCH_SIZE) {
    const batch = skuList.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(skuList.length / BATCH_SIZE)} (${batch.length} SKUs)... `);
    const res = await checkSkuBatch(batch);
    Object.assign(skuResults, res);
    const hits = batch.filter(s => res[s]).length;
    console.log(`${hits}/${batch.length} matched`);
  }

  const matched = [];
  const notFound = [];
  for (const sku of skuList) {
    if (skuResults[sku]) matched.push(sku); else notFound.push(sku);
  }

  // For NOT FOUND, check if handle exists with different SKUs
  console.log(`\nChecking handles for ${notFound.length} NOT FOUND SKUs (handle mismatch detection)...\n`);
  const handleMismatches = [];
  const handlesChecked = new Map();
  for (const t of TIERS) {
    for (const r of allRows[t.name].rows) {
      if (notFound.includes(r['Variant SKU']) && r.Handle && !handlesChecked.has(r.Handle)) {
        handlesChecked.set(r.Handle, null); // placeholder
      }
    }
  }
  const handleList = [...handlesChecked.keys()];
  for (let i = 0; i < handleList.length; i += BATCH_SIZE) {
    const batch = handleList.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async h => {
      handlesChecked.set(h, await checkHandle(h));
    }));
  }
  for (const [handle, info] of handlesChecked) {
    if (info) handleMismatches.push({ handle, productTitle: info.title, existingSkus: info.skus });
  }

  // DUPLICATE HANDLE: same handle in CSVs maps to different product IDs in Shopify
  const handleToProductIds = {};
  for (const t of TIERS) {
    for (const r of allRows[t.name].rows) {
      const sku = r['Variant SKU'];
      const handle = r.Handle;
      const info = skuResults[sku];
      if (!info || !handle) continue;
      if (!handleToProductIds[handle]) handleToProductIds[handle] = new Set();
      handleToProductIds[handle].add(info.productId);
    }
  }
  const duplicateHandles = Object.entries(handleToProductIds)
    .filter(([, ids]) => ids.size > 1)
    .map(([handle, ids]) => ({ handle, productIds: [...ids] }));

  // Write cleaned CSVs
  let removedTotal = 0;
  const removedDetail = [];
  for (const t of TIERS) {
    const { header, rows, def } = allRows[t.name];
    const cleaned = rows.filter(r => {
      const ok = skuResults[r['Variant SKU']];
      if (!ok) removedDetail.push({ tier: t.name, handle: r.Handle, sku: r['Variant SKU'] });
      return ok;
    });
    removedTotal += rows.length - cleaned.length;
    writeCSV(path.join(baseDir, def.output), header, cleaned);
    console.log(`  ${def.output}: ${cleaned.length} rows (removed ${rows.length - cleaned.length})`);
  }

  // Report
  console.log('\n========== MATCHED (' + matched.length + ') ==========');
  matched.forEach(s => console.log('  ' + s));

  console.log('\n========== NOT FOUND (' + notFound.length + ') ==========');
  notFound.forEach(s => console.log('  ' + s));

  console.log('\n========== HANDLE-EXISTS-BUT-SKU-MISSING (' + handleMismatches.length + ') ==========');
  console.log('(Handle exists in Shopify but the CSV SKU does not match any variant — likely handle mismatch, not missing product.)');
  handleMismatches.forEach(h => {
    console.log(`  ${h.handle}  ->  "${h.productTitle}"  existing SKUs: ${h.existingSkus.join(', ') || '(none)'}`);
  });

  console.log('\n========== DUPLICATE HANDLE (' + duplicateHandles.length + ') ==========');
  console.log('(Same Handle in CSV maps to multiple Shopify product IDs — manual review required.)');
  duplicateHandles.forEach(d => console.log(`  ${d.handle}  ->  ${d.productIds.join(', ')}`));

  console.log('\n========== SUMMARY ==========');
  console.log(`  Total unique SKUs checked: ${skuList.length}`);
  console.log(`  Matched:                   ${matched.length}`);
  console.log(`  Not found (rows removed):  ${removedTotal}`);
  console.log(`  Handle-exists mismatches:  ${handleMismatches.length}`);
  console.log(`  Duplicate handles:         ${duplicateHandles.length}`);
  console.log('\n  Removed rows (review manually before import):');
  removedDetail.forEach(r => console.log(`    [${r.tier}] ${r.handle}  |  ${r.sku}`));
}

main().catch(err => { console.error(err); process.exit(1); });
