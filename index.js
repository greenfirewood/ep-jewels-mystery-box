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

// Check if SKU matches a preference
function skuMatchesLetter(sku, letter) {
  return sku.includes(`-LTR-${letter}-`) || sku.includes(`-LTR-${letter}-`) || sku.includes(`-INTL-${letter}-`);
}

function skuMatchesNumber(sku, number) {
  return sku.includes(`-NUM-${number}-`) || sku.includes(`-NUM-${number}-`);
}

function skuMatchesRingSize(sku, size) {
  return sku.endsWith(`-${size}`) || sku.includes(`-${size}-`) || sku.includes(`-2TNE-${size}`);
}

function skuIsEarring(sku) {
  return sku.startsWith('E/');
}

function skuIsHatOrCase(sku) {
  return sku.startsWith('G/') || sku.startsWith('JB/');
}

function getProductType(sku) {
  if (sku.startsWith('N/')) return 'necklace';
  if (sku.startsWith('R/')) return 'ring';
  if (sku.startsWith('E/')) return 'earring';
  if (sku.startsWith('B/')) return 'bracelet';
  if (sku.startsWith('A/')) return 'anklet';
  if (sku.startsWith('G/')) return 'hat';
  if (sku.startsWith('JB/')) return 'case';
  return 'other';
}

// Main box assignment function
async function assignBox(boxSize, preferences) {
  const {
    metal,
    letter,
    luckyNumber,
    ringSize,
    earrings,
    religious,
    sports,
    sorority
  } = preferences;

  // Box compositions
  const compositions = {
    '2 Piece': { tier1: 0, tier2: 2, tier3: 0 },
    '4 Piece': { tier1: 1, tier2: 2, tier3: 1 },
    '6 Piece': { tier1: 1, tier2: 2, tier3: 3 },
  };

  const composition = compositions[boxSize];
  if (!composition) throw new Error(`Unknown box size: ${boxSize}`);

  // Fetch all eligible SKUs
  const [tier1Pool, tier2Pool, tier3Pool] = await Promise.all([
    getEligibleSKUs('tier-1', metal),
    getEligibleSKUs('tier-2', metal),
    getEligibleSKUs('tier-3', metal),
  ]);

  // Filter out earrings if customer said no
  const filterEarrings = (pool) => {
    if (earrings === 'No') return pool.filter(s => !skuIsEarring(s.sku));
    return pool;
  };

  // Filter out hats and cases from main pool
  const filterHatsAndCases = (pool) => pool.filter(s => !skuIsHatOrCase(s.sku));

  const t1 = filterHatsAndCases(filterEarrings(tier1Pool));
  const t2 = filterHatsAndCases(filterEarrings(tier2Pool));
  const t3 = filterHatsAndCases(filterEarrings(tier3Pool));

  const selected = [];
  const usedProductTypes = new Set();
  const usedProductIds = new Set();

  // Helper to pick from pool with preference matching
  const pickFromPool = (pool, preferenceFilter) => {
    // Try preference match first
    let candidates = pool.filter(s =>
      !usedProductIds.has(s.productId) &&
      preferenceFilter(s)
    );
  
    // Fall back to any eligible SKU not already used
    if (candidates.length === 0) {
      candidates = pool.filter(s => !usedProductIds.has(s.productId));
    }
  
    if (candidates.length === 0) return null;
  
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    usedProductIds.add(pick.productId);
    return pick;
  };


  // Priority slots - check sorority, sports, religious first
  const priorityPicks = [];

  if (sorority && sorority !== 'N/A') {
    const sorPick = t2.find(s =>
      s.sku.startsWith('N/SRTY') &&
      !usedProductIds.has(s.productId)
    );
    if (sorPick) priorityPicks.push({ pick: sorPick, tier: 'tier2' });
  }
  

if (sports && sports !== 'N/A') {
  const sportKeyword = sports.includes('Yankees') ? 'YANK' : 'RANGR';
  const sportPick = [...t1, ...t2].find(s =>
    s.sku.includes(sportKeyword) &&
    !usedProductIds.has(s.productId)
  );
  if (sportPick) {
    const tier = t1.find(s => s.variantId === sportPick.variantId) ? 'tier1' : 'tier2';
    priorityPicks.push({ pick: sportPick, tier });
  }
}

  if (religious && religious !== 'N/A') {
  const relKeyword = religious === 'Cross' ? 'CRS' : 'STR-DAV';
  const relPick = [...t1, ...t2].find(s => 
    s.sku.includes(relKeyword) && 
    !usedProductIds.has(s.productId)
  );
  if (relPick) {
    const tier = t1.includes(relPick) ? 'tier1' : 'tier2';
    priorityPicks.push({ pick: relPick, tier });
  }
}

  // Lock in priority picks
  for (const pp of priorityPicks) {
    usedProductIds.add(pp.pick.productId);
    usedProductTypes.add(getProductType(pp.pick.sku));
    selected.push({ ...pp.pick, tier: pp.tier, reason: 'priority' });
  }

  // Fill tier slots
  const fillSlots = (pool, count, tierName) => {
    // Count how many priority picks already used this tier
    const priorityInTier = selected.filter(s => s.tier === tierName && s.reason === 'priority').length;
    const slotsNeeded = count - priorityInTier;
  
    for (let i = 0; i < slotsNeeded; i++) {
      const pick = pickFromPool(pool, (s) => {
        return skuMatchesLetter(s.sku, letter) ||
               skuMatchesNumber(s.sku, luckyNumber) ||
               skuMatchesRingSize(s.sku, ringSize);
      });
      if (pick) selected.push({ ...pick, tier: tierName });
    }
  };

  fillSlots(t1, composition.tier1, 'tier1');
  fillSlots(t2, composition.tier2, 'tier2');
  fillSlots(t3, composition.tier3, 'tier3');

  return selected;
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
  try {
    const { order_id, box_size, preferences } = req.body;
    console.log('Order received:', order_id, box_size, preferences);

    const selected = await assignBox(box_size, preferences);

    if (selected.length === 0) {
      return res.json({
        success: false,
        tag: 'mb-manual-review',
        message: 'No eligible SKUs found for this preference combo'
      });
    }

    const packSlip = selected.map((s, i) =>
      `${i + 1}. [${s.tier.toUpperCase()}] ${s.productTitle} - SKU: ${s.sku}`
    ).join('\n');

    res.json({
      success: true,
      tag: 'mb-ready-to-pack',
      selected_skus: selected.map(s => s.sku),
      pack_slip: packSlip,
      order_id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
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