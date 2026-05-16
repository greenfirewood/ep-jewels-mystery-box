#!/usr/bin/env node
/**
 * Applies mystery-box tier tags + custom.mb_cap / custom.mb_used metafields to
 * EXISTING Shopify products/variants based on the three tier CSVs.
 *
 * HARD SAFETY GUARANTEES:
 *   - This script only ever calls two Shopify mutations: tagsAdd and metafieldsSet.
 *   - It does NOT call productCreate, productUpdate, productVariantCreate,
 *     productVariantUpdate, productDelete, or anything that can create or modify
 *     a product/variant beyond tags and metafields.
 *   - If a CSV SKU does not exactly match an existing variant in Shopify, that
 *     row is SKIPPED and logged. The script will not create the missing product.
 *   - Dry-run by default. --execute is required to call any mutations.
 *   - Requires typed confirmation. Max-write guard. Per-action log file.
 *
 * Usage:
 *   node apply-mystery-box-tags-and-caps.js               # dry-run
 *   node apply-mystery-box-tags-and-caps.js --execute     # do the writes
 *   node apply-mystery-box-tags-and-caps.js --execute --max=500
 *
 * Auth: SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SHOP = 'ep-the-label.myshopify.com';
const API_VERSION = '2025-01';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const MAX = (() => {
  const a = args.find(x => x.startsWith('--max='));
  return a ? parseInt(a.split('=')[1], 10) : 500;
})();

const TIERS = [
  { name: 'tier-1', tag: 'mystery-box-tier-1', csv: 'mystery-box-tier-1.csv' },
  { name: 'tier-2', tag: 'mystery-box-tier-2', csv: 'mystery-box-tier-2.csv' },
  { name: 'tier-3', tag: 'mystery-box-tier-3', csv: 'mystery-box-tier-3.csv' },
];

// --- CSV parser handling quoted fields with embedded quotes ---
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
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; });
    return o;
  });
}

// --- Auth ---
let TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

async function ensureToken() {
  if (TOKEN) return TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('ERROR: provide SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.');
    process.exit(1);
  }
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) { console.error(`Token exchange failed: ${r.status} ${await r.text()}`); process.exit(1); }
  TOKEN = (await r.json()).access_token;
  console.log('Fetched fresh access token.');
}

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401) { console.error('FATAL: 401 from Shopify. Aborting.'); process.exit(1); }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function preflight() {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': TOKEN },
  });
  if (!r.ok) { console.error(`Preflight failed: ${r.status} ${await r.text()}`); process.exit(1); }
  const { shop } = await r.json();
  console.log(`Preflight OK — "${shop.name}" (${shop.myshopify_domain})\n`);
}

// --- Lookups ---
const VARIANT_LOOKUP = `
  query($q: String!) {
    productVariants(first: 5, query: $q) {
      edges {
        node {
          id
          sku
          product { id title tags }
          cap: metafield(namespace: "custom", key: "mb_cap") { value }
          used: metafield(namespace: "custom", key: "mb_used") { value }
        }
      }
    }
  }
`;

async function findVariantBySku(sku) {
  const escaped = sku.replace(/'/g, "\\'");
  const data = await gql(VARIANT_LOOKUP, { q: `sku:'${escaped}'` });
  const match = data.productVariants.edges.find(e => e.node.sku === sku);
  return match ? match.node : null;
}

// --- Mutations (the ONLY two we use) ---
const TAGS_ADD = `
  mutation($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `
  mutation($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message }
    }
  }
`;

async function addTagIfMissing(productId, tag) {
  const d = await gql(TAGS_ADD, { id: productId, tags: [tag] });
  const errs = d.tagsAdd.userErrors;
  if (errs.length) throw new Error(`tagsAdd: ${JSON.stringify(errs)}`);
}

async function setCapMetafields(variantId, cap, used) {
  const d = await gql(METAFIELDS_SET, {
    metafields: [
      { ownerId: variantId, namespace: 'custom', key: 'mb_cap', type: 'number_integer', value: String(cap) },
      { ownerId: variantId, namespace: 'custom', key: 'mb_used', type: 'number_integer', value: String(used) },
    ],
  });
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
}

// --- Plan building ---
function loadCsvRows() {
  const rows = [];
  for (const t of TIERS) {
    const text = fs.readFileSync(path.join(__dirname, t.csv), 'utf8');
    for (const r of parseCSV(text)) {
      rows.push({
        tier: t.name,
        tag: t.tag,
        sku: r['Variant SKU'],
        cap: parseInt(r['Metafield: custom.mb_cap [integer]'], 10),
        used: parseInt(r['Metafield: custom.mb_used [integer]'], 10) || 0,
      });
    }
  }
  return rows;
}

async function buildPlan(rows) {
  const plan = [];
  const missing = [];
  let i = 0;
  for (const row of rows) {
    i++;
    if (i % 25 === 0) process.stdout.write(`  resolved ${i}/${rows.length}...\r`);
    const v = await findVariantBySku(row.sku);
    if (!v) { missing.push(row); continue; }
    const tagNeeded = !v.product.tags.includes(row.tag);
    const currentCap = v.cap ? parseInt(v.cap.value, 10) : null;
    const currentUsed = v.used ? parseInt(v.used.value, 10) : null;
    const capNeedsWrite = currentCap !== row.cap;
    const usedNeedsWrite = currentUsed === null; // never overwrite an existing used value
    plan.push({
      ...row,
      productId: v.product.id,
      productTitle: v.product.title,
      variantId: v.id,
      currentTags: v.product.tags,
      currentCap, currentUsed,
      actions: {
        addTag: tagNeeded,
        setCap: capNeedsWrite,
        setUsed: usedNeedsWrite,
      },
    });
  }
  process.stdout.write(`  resolved ${rows.length}/${rows.length}    \n`);
  return { plan, missing };
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

(async () => {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}\nMax writes allowed: ${MAX}\n`);

  await ensureToken();
  await preflight();

  console.log('Loading CSVs...');
  const rows = loadCsvRows();
  console.log(`  ${rows.length} total rows across 3 tiers\n`);

  console.log('Resolving each SKU against Shopify...');
  const { plan, missing } = await buildPlan(rows);

  const tagWrites = plan.filter(p => p.actions.addTag).length;
  const capWrites = plan.filter(p => p.actions.setCap || p.actions.setUsed).length;
  console.log('');
  console.log(`Resolved: ${plan.length}   Missing (will skip): ${missing.length}`);
  console.log(`Tag writes needed: ${tagWrites}`);
  console.log(`Metafield writes needed: ${capWrites}\n`);

  // Write manifest
  const manifestPath = path.join(__dirname, 'apply-plan.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ plan, missing }, null, 2));
  console.log(`Plan written to ${manifestPath}\n`);

  if (missing.length) {
    console.log('--- MISSING (SKIPPED — no Shopify variant) ---');
    missing.forEach(m => console.log(`  [${m.tier}] ${m.sku}`));
    console.log('');
  }

  if (tagWrites === 0 && capWrites === 0) {
    console.log('Nothing to do — everything is already in the desired state.');
    return;
  }

  if (tagWrites + capWrites > MAX) {
    console.error(`ABORT: total writes (${tagWrites + capWrites}) exceeds --max=${MAX}.`);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('Dry-run complete. Re-run with --execute to apply.');
    return;
  }

  const confirmToken = `yes-apply-${tagWrites}-tags-${capWrites}-metafields`;
  const ans = await prompt(`Type "${confirmToken}" to proceed: `);
  if (ans !== confirmToken) { console.log('Confirmation mismatch. Aborting.'); return; }

  const logPath = path.join(__dirname, `apply-tags-caps-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = entry => fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');

  console.log(`\nExecuting... log: ${logPath}\n`);
  let ok = 0, failed = 0;

  // Dedupe tag writes by product (avoid hitting tagsAdd twice for the same product)
  const productsTaggedThisRun = new Set();

  for (const item of plan) {
    try {
      if (item.actions.addTag && !productsTaggedThisRun.has(item.productId)) {
        await addTagIfMissing(item.productId, item.tag);
        productsTaggedThisRun.add(item.productId);
        console.log(`  TAG  ${item.sku}  -> ${item.tag} on ${item.productTitle}`);
        log({ ts: new Date().toISOString(), action: 'tagsAdd', productId: item.productId, tag: item.tag, sku: item.sku });
      }
      if (item.actions.setCap || item.actions.setUsed) {
        const usedToWrite = item.actions.setUsed ? item.used : item.currentUsed;
        await setCapMetafields(item.variantId, item.cap, usedToWrite);
        console.log(`  MF   ${item.sku}  cap=${item.cap} used=${usedToWrite}`);
        log({ ts: new Date().toISOString(), action: 'metafieldsSet', variantId: item.variantId, sku: item.sku, cap: item.cap, used: usedToWrite });
      }
      ok++;
    } catch (err) {
      console.error(`  FAIL ${item.sku}: ${err.message}`);
      log({ ts: new Date().toISOString(), action: 'error', sku: item.sku, error: err.message });
      failed++;
    }
    await sleep(150);
  }

  console.log(`\nDone. ${ok} rows succeeded, ${failed} failed. Log: ${logPath}`);
})();
