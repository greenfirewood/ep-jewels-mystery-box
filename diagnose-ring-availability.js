#!/usr/bin/env node
/**
 * Why is ring size N showing sold-out in the customizer?
 *
 * For every ring SKU (R/*) that has mb_remaining > 0, this prints:
 *   - the SKU
 *   - which tiers it's tagged for
 *   - whether it's in the engine's ALLOWED_SKUS (from tier CSVs)
 *   - inferred ring size + metal
 *
 * Run after the customer says "I see N (sold out)" to find the gap.
 */
const fs = require('fs');
const path = require('path');
const STORE = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
if (!STORE || !TOKEN) { console.error('Need SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN'); process.exit(1); }

// Load ALLOWED_SKUS from tier CSVs (same source as engine)
function loadAllowedSkus() {
  const allowed = new Set();
  for (const tier of ['1', '2', '3']) {
    const file = path.join(__dirname, `mystery-box-tier-${tier}-clean.csv`);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const cols = line.split(',');
      if (cols[2]) allowed.add(cols[2].replace(/^"|"$/g, ''));
    }
  }
  return allowed;
}

async function gql(query) {
  const r = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await r.json()).data;
}

function detectMetal(sku) {
  if (/-TT(-|$)/.test(sku) || /-2TNE(-|$)/.test(sku)) return 'both';
  if (/-GLD(-\d+)?$/.test(sku) || /-G$/.test(sku) || /-GLD-/.test(sku)) return 'gold';
  if (/-SLVR(-\d+)?$/.test(sku) || /-S$/.test(sku) || /-SLVR-/.test(sku)) return 'silver';
  return 'unknown';
}

function extractSize(sku) {
  // Match trailing -N, -N- in middle, or -2TNE-N
  const m = sku.match(/-2TNE-(\d+)$/) || sku.match(/-(\d+)$/) || sku.match(/-(\d+)-(?!.*\d)/);
  return m ? m[1] : null;
}

(async () => {
  const allowed = loadAllowedSkus();
  console.log(`Loaded ${allowed.size} allowlist SKUs from CSVs\n`);

  const data = await gql(`{
    products(first: 250, query: "tag:mystery-box-tier-1 OR tag:mystery-box-tier-2 OR tag:mystery-box-tier-3") {
      edges { node { handle title status tags variants(first: 50) { edges { node { sku
        metafields(first: 10, namespace: "custom") { edges { node { key value } } }
      } } } } }
    }
  }`);

  const rings = [];
  for (const p of data.products.edges) {
    const tags = p.node.tags.filter(t => /mystery-box-tier-/.test(t));
    const status = p.node.status;
    for (const v of p.node.variants.edges) {
      const sku = v.node.sku || '';
      if (!sku.startsWith('R/')) continue;
      const mf = Object.fromEntries(v.node.metafields.edges.map(e => [e.node.key, e.node.value]));
      const remaining = parseInt(mf.mb_remaining || '0', 10);
      rings.push({
        sku,
        product: p.node.handle,
        status,
        tiers: tags.join(','),
        remaining,
        inAllowed: allowed.has(sku),
        metal: detectMetal(sku),
        size: extractSize(sku),
      });
    }
  }

  // Engine-eligible only: status=active AND mb_remaining > 0 AND in CSV
  console.log('\n--- Size 7 SKUs that match ENGINE filters (status:active + remaining>0 + inCSV) ---');
  const size7eligible = rings.filter(r => r.size === '7' && r.status === 'ACTIVE' && r.remaining > 0 && r.inAllowed);
  size7eligible.forEach(r => console.log(' ', r.sku.padEnd(35), 'status='+r.status, 'metal='+r.metal));

  console.log('\n--- Size 7 SKUs that PASS diagnostic but FAIL engine (status != active) ---');
  rings.filter(r => r.size === '7' && r.remaining > 0 && r.inAllowed && r.status !== 'ACTIVE')
    .forEach(r => console.log(' ', r.sku.padEnd(35), 'status='+r.status));

  console.log('\n--- Eligibility per size (status:active + remaining>0 + inCSV) ---');
  for (const size of ['2','3','4','5','6','7','8','9','10']) {
    const gold = rings.filter(r => r.size === size && (r.metal === 'gold' || r.metal === 'both') && r.remaining > 0 && r.inAllowed && r.status === 'ACTIVE');
    const silver = rings.filter(r => r.size === size && (r.metal === 'silver' || r.metal === 'both') && r.remaining > 0 && r.inAllowed && r.status === 'ACTIVE');
    console.log(`size ${size.padStart(2)}: gold=${gold.length}, silver=${silver.length}`);
  }
})();
