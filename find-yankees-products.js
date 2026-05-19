#!/usr/bin/env node
const STORE = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
(async () => {
  for (const tier of ['tier-1', 'tier-2', 'tier-3']) {
    const r = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{
        products(first: 100, query: "tag:mystery-box-${tier}") {
          edges { node { id handle title tags variants(first: 50) { edges { node { sku } } } } }
        }
      }` }),
    });
    const j = await r.json();
    for (const p of j.data.products.edges) {
      const yankSkus = p.node.variants.edges.map(e => e.node.sku || '').filter(s => /YANK|YANKEE/i.test(s));
      const yankTitle = /yankee/i.test(p.node.title);
      if (yankSkus.length || yankTitle) {
        console.log(`[${tier}] ${p.node.handle} | ${p.node.title}`);
        console.log(`  id: ${p.node.id}`);
        console.log(`  tags: ${p.node.tags.join(', ')}`);
        console.log(`  yankee SKUs: ${yankSkus.join(', ')}`);
      }
    }
  }
})();
