#!/usr/bin/env node
/**
 * Diagnoses why priority picks (Star of David, NY Rangers) may not fire.
 * For each known priority SKU, verifies:
 *   - the variant exists in Shopify
 *   - the parent product is tagged with the expected mystery-box-tier-N
 *   - the variant has custom.mb_cap and custom.mb_used metafields
 *   - mb_used < mb_cap (variant is eligible)
 */

const SHOP = 'ep-the-label.myshopify.com';
const API = '2025-01';

const PRIORITY_SKUS = [
  // Star of David / Chai (tier 2)
  { sku: 'N/STR-DAV+CHAI-BOX-16"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  { sku: 'N/STR-DAV+CHAI-BOX-18"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  { sku: 'N/STR-DAV+CHAI-BOX-16"-KT-SLVR', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  { sku: 'N/STR-DAV+CHAI-BOX-18"-KT-SLVR', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  { sku: 'N/STR-DAV-BOX-16"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  { sku: 'N/STR-DAV-BOX-18"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'religious-star-of-david' },
  // NY Rangers (tier 2)
  { sku: 'N/CLSC-NY-RANGR-BOX-16"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'sports-rangers' },
  { sku: 'N/CLSC-NY-RANGR-BOX-18"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'sports-rangers' },
  { sku: 'N/CLSC-NY-RANGR-BOX-16"-KT-SLVR', expectedTag: 'mystery-box-tier-2', category: 'sports-rangers' },
  { sku: 'N/CLSC-NY-RANGR-BOX-18"-KT-SLVR', expectedTag: 'mystery-box-tier-2', category: 'sports-rangers' },
  // Cross (tier 1 — known working, sanity check)
  { sku: 'N/CRS-BOX-16"-KT-GLD', expectedTag: 'mystery-box-tier-1', category: 'religious-cross' },
  // Letter spot-checks (verify the apply hit them)
  { sku: 'N/CZ-LTR-S-CHRM-G', expectedTag: 'mystery-box-tier-2', category: 'letter-S-charm' },
  { sku: 'N/LAR-LTR-S-GLD', expectedTag: 'mystery-box-tier-1', category: 'letter-S-lariat' },
  { sku: 'N/CZ-BUB-INTL-S-BOX-16"-KT-GLD', expectedTag: 'mystery-box-tier-2', category: 'letter-S-bubble' },
];

async function getToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) { console.error('Need SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET'); process.exit(1); }
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  return (await r.json()).access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

const VARIANT_BY_SKU = `
  query($q: String!) {
    productVariants(first: 5, query: $q) {
      edges {
        node {
          id
          sku
          product { id title tags status }
          cap: metafield(namespace: "custom", key: "mb_cap") { value }
          used: metafield(namespace: "custom", key: "mb_used") { value }
        }
      }
    }
  }
`;

(async () => {
  const token = await getToken();
  console.log(`\nDiagnosing ${PRIORITY_SKUS.length} priority SKUs against ${SHOP}\n`);
  console.log('STATUS  TAG-OK  CAP-OK  ELIGIBLE  SKU');
  console.log('------  ------  ------  --------  ---');

  for (const { sku, expectedTag, category } of PRIORITY_SKUS) {
    const escaped = sku.replace(/'/g, "\\'");
    const data = await gql(token, VARIANT_BY_SKU, { q: `sku:'${escaped}'` });
    const match = data.data?.productVariants?.edges?.find(e => e.node.sku === sku);

    if (!match) {
      console.log(`[MISS]  ------  ------  --------  ${sku}  <-- NOT FOUND in Shopify (${category})`);
      continue;
    }
    const v = match.node;
    const tagOk = v.product.tags.includes(expectedTag);
    const cap = v.cap ? parseInt(v.cap.value, 10) : null;
    const used = v.used ? parseInt(v.used.value, 10) : null;
    const capOk = cap !== null && used !== null;
    const eligible = capOk && used < cap;

    const tagFlag = tagOk ? '  YES ' : '  NO! ';
    const capFlag = capOk ? '  YES ' : '  NO! ';
    const eligFlag = eligible ? '  YES   ' : '  NO!   ';
    console.log(`[${v.product.status}]  ${tagFlag}  ${capFlag}  ${eligFlag}  ${sku}`);
    if (!tagOk) console.log(`         actual tags: [${v.product.tags.join(', ')}]`);
    if (!capOk) console.log(`         cap=${cap}, used=${used}`);
    if (capOk && !eligible) console.log(`         used (${used}) >= cap (${cap})`);
  }
  console.log('');
})();
