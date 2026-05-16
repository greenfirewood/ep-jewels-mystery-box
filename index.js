const express = require('express');
const app = express();
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
let SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

// Mint a fresh access token via client_credentials. Cached in SHOPIFY_TOKEN.
async function refreshShopifyToken() {
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Cannot refresh: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set');
  }
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('Token exchange returned no access_token');
  SHOPIFY_TOKEN = access_token;
  console.log('[auth] refreshed shopify access token');
  return SHOPIFY_TOKEN;
}

async function ensureToken() {
  if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;
  return refreshShopifyToken();
}

// Shopify GraphQL helper. Auto-refreshes token on 401 and retries once.
// Logs GraphQL errors so they don't get swallowed silently.
async function shopifyGraphQL(query, variables = {}, _retried = false) {
  await ensureToken();
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401 && !_retried) {
    console.warn('[auth] 401 from Shopify — refreshing token and retrying');
    await refreshShopifyToken();
    return shopifyGraphQL(query, variables, true);
  }
  const json = await response.json();
  if (json.errors) {
    console.error('[graphql] errors:', JSON.stringify(json.errors));
  }
  return json;
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

// Read current mb_used metafield + compareDigest for a single variant
async function readMbUsed(variantId) {
  const query = `
    query($id: ID!) {
      productVariant(id: $id) {
        id
        metafield(namespace: "custom", key: "mb_used") {
          id
          value
          compareDigest
        }
      }
    }
  `;
  const res = await shopifyGraphQL(query, { id: variantId });
  const mf = res.data?.productVariant?.metafield;
  return {
    used: mf?.value ? parseInt(mf.value, 10) : 0,
    compareDigest: mf?.compareDigest ?? null,
  };
}

// Increment mb_used by 1 with optimistic concurrency. Retries on digest mismatch.
async function incrementMbUsed(variant, maxAttempts = 3) {
  const { variantId, productId, sku } = variant;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { used, compareDigest } = await readMbUsed(variantId);
    const next = used + 1;

    const mutation = `
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message code }
        }
      }
    `;
    const input = {
      metafields: [{
        ownerId: variantId,
        namespace: 'custom',
        key: 'mb_used',
        type: 'number_integer',
        value: String(next),
        ...(compareDigest ? { compareDigest } : {}),
      }],
    };
    const res = await shopifyGraphQL(mutation, input);
    const errs = res.data?.metafieldsSet?.userErrors || [];
    const stale = errs.find(e => e.code === 'STALE_OBJECT' || /digest|stale/i.test(e.message));
    if (stale) {
      console.warn(`[mb_used] digest mismatch for ${sku} attempt ${attempt}/${maxAttempts} — refetching`);
      continue;
    }
    if (errs.length) {
      throw new Error(`metafieldsSet failed for ${sku}: ${JSON.stringify(errs)}`);
    }
    return { sku, variantId, productId, previous: used, current: next, attempts: attempt };
  }
  throw new Error(`incrementMbUsed: gave up after ${maxAttempts} attempts for ${variant.sku}`);
}

// Increment mb_used for every selected variant. Returns per-SKU result list.
// Failures are logged but do not throw — the order is already placed; manual
// reconciliation is preferable to surfacing a 500 to the merchant.
async function decrementCaps(selected) {
  const results = [];
  for (const item of selected) {
    try {
      const r = await incrementMbUsed(item);
      console.log(`[mb_used] ${r.sku}: ${r.previous} -> ${r.current} (attempts=${r.attempts})`);
      results.push({ ...r, ok: true });
    } catch (err) {
      console.error(`[mb_used] FAILED ${item.sku}: ${err.message}`);
      results.push({ sku: item.sku, variantId: item.variantId, ok: false, error: err.message });
    }
  }
  return results;
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
async function assignBox(boxSize, preferences, options = {}) {
  const { dryRun = false } = options;
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

  const filterSorority = (pool) => {
    if (!sorority || sorority === 'N/A') return pool.filter(s => !s.sku.startsWith('N/SRTY'));
    return pool;
  };
  
  const t1 = filterHatsAndCases(filterEarrings(tier1Pool));
  const t2 = filterHatsAndCases(filterEarrings(filterSorority(tier2Pool)));
  const t3 = filterHatsAndCases(filterEarrings(tier3Pool));

  const selected = [];
  const usedProductTypes = new Set();
  const usedProductIds = new Set();

  // Weighted preference scoring. Higher = better match. Letter > number > ring.
  const scoreCandidate = (s) => {
    let score = 0;
    if (letter && skuMatchesLetter(s.sku, letter)) score += 100;
    if (luckyNumber && skuMatchesNumber(s.sku, luckyNumber)) score += 50;
    if (ringSize && skuMatchesRingSize(s.sku, ringSize)) score += 10;
    return score;
  };

  // Pick the highest-scoring eligible candidate. Random tiebreak among top scorers
  // gives variety when multiple SKUs match the same preferences equally well.
  const pickFromPool = (pool) => {
    const available = pool.filter(s => !usedProductIds.has(s.productId));
    if (available.length === 0) return null;
    const scored = available.map(s => ({ s, score: scoreCandidate(s) }));
    const maxScore = Math.max(...scored.map(x => x.score));
    const top = scored.filter(x => x.score === maxScore).map(x => x.s);
    const pick = top[Math.floor(Math.random() * top.length)];
    usedProductIds.add(pick.productId);
    return pick;
  };


  console.log('Sports value:', sports);
console.log('Religious value:', religious);
console.log('T2 RANGR SKUs:', t2.filter(s => s.sku.includes('RANGR')).map(s => s.sku));
console.log('T1+T2 CRS SKUs:', [...t1, ...t2].filter(s => s.sku.includes('CRS')).map(s => s.sku));
console.log('Silver T2 count:', t2.length);
console.log('Silver T2 SKUs:', t2.map(s => s.sku));

  // Priority slots - check sorority, sports, religious first
  const priorityPicks = [];

  const sorNameMap = {
    'Alpha Chi Omega': 'AChiO',
    'Alpha Delta Pi': 'ADeltaP',
    'Alpha Omicron Pi': 'AOmicronP',
    'Alpha Phi': 'APhi',
    'Chi Omega': 'COmega',
    'Delta Delta Delta': 'DDeltaD',
    'Delta Gamma': 'DGamma',
    'Delta Zeta': 'DZeta',
    'Kappa Alpha Theta': 'KAlphaT',
    'Kappa Delta': 'KDelta',
    'Kappa Kappa Gamma': 'KKappaG',
    'Pi Beta Phi': 'PBetaP',
    'Sigma Sigma Sigma': 'SSigmaS',
    'Zeta Tau Alpha': 'ZTauA',
  };
  
  if (sorority && sorority !== 'N/A') {
    const sorCode = sorNameMap[sorority];
    if (sorCode) {
      const sorPick = t2.find(s =>
        s.sku.includes(sorCode) &&
        !usedProductIds.has(s.productId)
      );
      if (sorPick) priorityPicks.push({ pick: sorPick, tier: 'tier2' });
    }
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

  // Fill tier slots. Returns { needed, filled } so caller can detect shortfalls.
  const fillSlots = (pool, count, tierName) => {
    const priorityInTier = selected.filter(s => s.tier === tierName && s.reason === 'priority').length;
    const slotsNeeded = count - priorityInTier;
    let filled = 0;
    for (let i = 0; i < slotsNeeded; i++) {
      const pick = pickFromPool(pool);
      if (pick) { selected.push({ ...pick, tier: tierName }); filled++; }
      else break; // pool exhausted; no point looping
    }
    return { tierName, needed: slotsNeeded, filled };
  };

  const fills = [
    fillSlots(t1, composition.tier1, 'tier1'),
    fillSlots(t2, composition.tier2, 'tier2'),
    fillSlots(t3, composition.tier3, 'tier3'),
  ];
  const shortfalls = fills.filter(f => f.filled < f.needed);
  const expectedTotal = composition.tier1 + composition.tier2 + composition.tier3;

  if (dryRun) {
    console.log('[dry-run] skipping cap decrement');
  } else if (selected.length > 0 && shortfalls.length === 0) {
    const capResults = await decrementCaps(selected);
    const failed = capResults.filter(r => !r.ok);
    if (failed.length) {
      console.warn(`[mb_used] ${failed.length}/${capResults.length} cap updates failed — manual review needed`);
    }
  } else if (shortfalls.length > 0) {
    console.warn('[shortfall] not decrementing caps because box is incomplete:', shortfalls);
  }

  return { selected, shortfalls, expectedTotal };
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
    const { order_id, box_size, preferences, dry } = req.body;
    const dryRun = dry === true || dry === 'true' || req.query.dry === '1' || req.query.dry === 'true';
    console.log('Order received:', order_id, box_size, preferences, dryRun ? '(DRY-RUN)' : '');

    const { selected, shortfalls, expectedTotal } = await assignBox(box_size, preferences, { dryRun });

    if (selected.length === 0) {
      return res.json({
        success: false,
        tag: 'mb-manual-review',
        message: 'No eligible SKUs found for this preference combo',
        order_id,
      });
    }

    const packSlip = selected.map((s, i) =>
      `${i + 1}. [${s.tier.toUpperCase()}] ${s.productTitle} - SKU: ${s.sku}`
    ).join('\n');

    const isShort = shortfalls.length > 0;
    res.json({
      success: !isShort,
      dry_run: dryRun,
      tag: isShort ? 'mb-manual-review' : (dryRun ? 'mb-dry-run' : 'mb-ready-to-pack'),
      selected_skus: selected.map(s => s.sku),
      pack_slip: packSlip,
      expected_total: expectedTotal,
      actual_total: selected.length,
      shortfalls,
      order_id,
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