const express = require('express');
const app = express();
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Shopify GraphQL helper
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

// Fetch eligible SKUs by tier
async function getEligibleSKUs(tier, metalPreference) {
  const tag = `mystery-box-${tier}`;
  const metalSuffix = metalPreference === 'Yellow Gold' ? 'GLD' : 'SLVR';

  const query = `
    {
      products(first: 250, query: "tag:${tag} AND status:active") {
        edges {
          node {
            id
            title
            tags
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  title
                  inventoryQuantity
                  metafields(first: 5, namespace: "custom") {
                    edges {
                      node {
                        key
                        value
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query);
  const products = result.data.products.edges;

  // Filter variants by metal preference and cap availability
  const eligible = [];

  for (const product of products) {
    for (const variantEdge of product.node.variants.edges) {
      const variant = variantEdge.node;
      const sku = variant.sku || '';

      // Check metal match - TWO-TONE eligible for both
      const isGold = sku.includes('GLD') || sku.includes('2TNE') || sku.includes('TT');
      const isSilver = sku.includes('SLVR') || sku.includes('2TNE') || sku.includes('TT');
      const metalMatch = metalPreference === 'Yellow Gold' ? isGold : isSilver;

      if (!metalMatch) continue;

      // Check mb_cap and mb_used metafields
      const metafields = {};
      for (const mf of variant.metafields.edges) {
        metafields[mf.node.key] = mf.node.value;
      }

      const cap = metafields.mb_cap ? parseInt(metafields.mb_cap) : 9999;
      const used = metafields.mb_used ? parseInt(metafields.mb_used) : 0;

      if (used >= cap) continue;

      eligible.push({
        productId: product.node.id,
        productTitle: product.node.title,
        productTags: product.node.tags,
        variantId: variant.id,
        sku: sku,
        cap: cap,
        used: used,
        remaining: cap - used,
      });
    }
  }

  return eligible;
}

// Health check
app.get('/', (req, res) => {
  res.send('EP Jewels Mystery Box Engine - Running');
});

// Test Shopify connection
app.get('/test', async (req, res) => {
  try {
    const result = await shopifyGraphQL(`
      {
        shop {
          name
          myshopifyDomain
        }
      }
    `);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test-skus', async (req, res) => {
  try {
    const tier1 = await getEligibleSKUs('tier-1', 'Yellow Gold');
    const tier2 = await getEligibleSKUs('tier-2', 'Yellow Gold');
    const tier3 = await getEligibleSKUs('tier-3', 'Yellow Gold');
    res.json({
      tier1_count: tier1.length,
      tier2_count: tier2.length,
      tier3_count: tier3.length,
      tier1_sample: tier1.slice(0, 3),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main assignment endpoint
app.post('/assign', async (req, res) => {
  const { order_id, preferences } = req.body;
  console.log('Order received:', order_id, preferences);
  res.json({ success: true, message: 'Assignment engine placeholder' });
});

// Availability check endpoint
app.post('/availability', async (req, res) => {
  const { preferences } = req.body;
  console.log('Availability check:', preferences);
  res.json({ available: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mystery box engine running on port ${PORT}`);
});