#!/usr/bin/env node
const SHOP = 'ep-the-label.myshopify.com';
const API = '2025-01';
const TIERS = ['mystery-box-tier-1', 'mystery-box-tier-2', 'mystery-box-tier-3'];

async function getToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) { console.error('Need SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID+SHOPIFY_CLIENT_SECRET'); process.exit(1); }
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) { console.error(`Token fetch failed: ${r.status} ${await r.text()}`); process.exit(1); }
  return (await r.json()).access_token;
}

async function gql(token, query) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) { console.error(JSON.stringify(j.errors)); process.exit(1); }
  return j.data;
}

(async () => {
  const token = await getToken();
  for (const tier of TIERS) {
    const d = await gql(token, `{
      products(first: 100, query: "tag:${tier}") {
        edges { node { id title tags variants(first: 10) { edges { node { price } } } } }
      }
    }`);
    const items = d.products.edges.map(e => e.node);
    const zero = items.filter(p => p.variants.edges.length > 0 && p.variants.edges.every(v => parseFloat(v.node.price) === 0));
    console.log(`${tier}: ${items.length} products, ${zero.length} with all-$0 variants`);
    zero.forEach(p => console.log(`   $0 -> ${p.id} | ${p.title} | tags=[${p.tags.join(', ')}]`));
  }
})();
