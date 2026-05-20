const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

// --- Bearer-token guard for /assign. Flow sends Authorization: Bearer <secret>;
// the engine compares against ENGINE_SECRET with a constant-time check. If
// ENGINE_SECRET is unset the endpoint stays open (so local/dev runs don't break),
// and a warning is logged at boot.
const ENGINE_SECRET = process.env.ENGINE_SECRET || '';
if (!ENGINE_SECRET) {
  console.warn('[auth] ENGINE_SECRET not set — /assign is UNGUARDED');
}
function requireEngineSecret(req, res, next) {
  if (!ENGINE_SECRET) return next();
  const header = req.headers.authorization || '';
  const expected = `Bearer ${ENGINE_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// --- CORS: allow the storefront to POST to /availability and /assign from
// the browser. Allowlist is intentionally narrow (storefront origins only);
// the Shopify Flow HTTP call is server-to-server and not bound by CORS.
const ALLOWED_ORIGINS = new Set([
  'https://epjewels.co',
  'https://www.epjewels.co',
  'https://ep-the-label.myshopify.com',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || /\.shopifypreview\.com$/.test(new URL(origin).hostname))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
let SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

// --- SKU allowlist loaded from the three tier CSVs at startup. Shopify tags are
// product-level, so a tagged product exposes ALL its variants as eligible. The
// allowlist clamps the pool down to only the explicit variant SKUs from the spec.
function parseCsvLine(text) {
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
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const header = rows.shift();
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== '')).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; });
    return o;
  });
}

const ALLOWED_SKUS = (() => {
  const set = new Set();
  for (const f of ['mystery-box-tier-1.csv', 'mystery-box-tier-2.csv', 'mystery-box-tier-3.csv']) {
    try {
      const text = fs.readFileSync(path.join(__dirname, f), 'utf8');
      for (const r of parseCsvLine(text)) if (r['Variant SKU']) set.add(r['Variant SKU']);
    } catch (e) {
      console.error(`[allowlist] failed to load ${f}: ${e.message}`);
    }
  }
  console.log(`[allowlist] loaded ${set.size} approved SKUs from tier CSVs`);
  return set;
})();

// Group caps were dropped when migrating to single-counter mb_remaining.
// Each variant now owns its own remaining budget; the client manages totals
// by adjusting per-variant mb_remaining manually if a shared-pool budget is
// needed. Kept as an empty Map for backward-compat with any stale references.
const GROUP_CAP_HANDLES = new Map();

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
      products(first: 250, query: "tag:${tag}") {
        edges {
          node {
            id
            handle
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

  const eligible = [];

  for (const product of products) {
    const handle = product.node.handle;

    for (const variantEdge of product.node.variants.edges) {
      const variant = variantEdge.node;
      const sku = variant.sku || '';
      const isBonus = skuIsHatOrCase(sku);

      // Bonus items (hats/cases) bypass the metal filter — they have no metal
      // and ship regardless of customer preference.
      const metal = detectSkuMetal(sku);
      const metalMatch = isBonus || metal === 'both' ||
        (metalPreference === 'Yellow Gold' && metal === 'gold') ||
        (metalPreference === 'Silver' && metal === 'silver');
      if (!metalMatch) continue;

      const metafields = {};
      for (const mf of variant.metafields.edges) {
        metafields[mf.node.key] = mf.node.value;
      }
      const remaining = metafields.mb_remaining ? parseInt(metafields.mb_remaining, 10) : 0;
      if (remaining <= 0) continue;

      if (!ALLOWED_SKUS.has(sku)) continue;

      eligible.push({
        productId: product.node.id,
        productHandle: handle,
        productTitle: product.node.title,
        productTags: product.node.tags,
        variantId: variant.id,
        sku,
        remaining,
        isBonus,
      });
    }
  }

  return eligible;
}

// Read current mb_remaining metafield + compareDigest for a single variant
async function readMbRemaining(variantId) {
  const query = `
    query($id: ID!) {
      productVariant(id: $id) {
        id
        metafield(namespace: "custom", key: "mb_remaining") {
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
    remaining: mf?.value ? parseInt(mf.value, 10) : 0,
    compareDigest: mf?.compareDigest ?? null,
  };
}

// Decrement mb_remaining by 1 with optimistic concurrency. Retries on digest mismatch.
// Refuses to go below 0 — if a race lands us at 0 already, returns previous=0/current=0
// and lets the caller decide whether that's a shortfall.
async function decrementMbRemaining(variant, maxAttempts = 3) {
  const { variantId, productId, sku } = variant;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { remaining, compareDigest } = await readMbRemaining(variantId);
    const next = Math.max(0, remaining - 1);

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
        key: 'mb_remaining',
        type: 'number_integer',
        value: String(next),
        ...(compareDigest ? { compareDigest } : {}),
      }],
    };
    const res = await shopifyGraphQL(mutation, input);
    const errs = res.data?.metafieldsSet?.userErrors || [];
    const stale = errs.find(e => e.code === 'STALE_OBJECT' || /digest|stale/i.test(e.message));
    if (stale) {
      console.warn(`[mb_remaining] digest mismatch for ${sku} attempt ${attempt}/${maxAttempts} — refetching`);
      continue;
    }
    if (errs.length) {
      throw new Error(`metafieldsSet failed for ${sku}: ${JSON.stringify(errs)}`);
    }
    return { sku, variantId, productId, previous: remaining, current: next, attempts: attempt };
  }
  throw new Error(`decrementMbRemaining: gave up after ${maxAttempts} attempts for ${variant.sku}`);
}

// Write the pack slip to the order's note and add a status tag in one round-trip.
// Uses orderUpdate for the note + tagsAdd for the tag (additive — preserves
// existing tags). Errors are logged but don't fail the whole assignment.
async function writeOrderNoteAndTag(orderId, note, tag) {
  if (!orderId || !orderId.startsWith('gid://shopify/Order/')) {
    console.warn(`[order-write] skipping — invalid orderId: ${orderId}`);
    return { ok: false, reason: 'invalid-order-id' };
  }
  try {
    const noteRes = await shopifyGraphQL(`
      mutation($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }
    `, { input: { id: orderId, note } });
    const noteErrs = noteRes.data?.orderUpdate?.userErrors || [];
    if (noteErrs.length) throw new Error(`orderUpdate: ${JSON.stringify(noteErrs)}`);

    const tagRes = await shopifyGraphQL(`
      mutation($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
      }
    `, { id: orderId, tags: [tag] });
    const tagErrs = tagRes.data?.tagsAdd?.userErrors || [];
    if (tagErrs.length) throw new Error(`tagsAdd: ${JSON.stringify(tagErrs)}`);

    console.log(`[order-write] ${orderId}: note set, tag "${tag}" added`);
    return { ok: true };
  } catch (err) {
    console.error(`[order-write] ${orderId} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Write the assigned component SKUs to a structured order metafield so any
// downstream system (custom warehouse sync, ShipStation Tags-into-Custom-Fields
// rules, internal dashboards) can read a clean machine-readable manifest off
// the order without having to parse the prose pack-slip in the note. Metafields
// are not customer-facing by default on the order status page.
async function writeOrderComponentsMetafield(orderId, selected) {
  if (!orderId || !orderId.startsWith('gid://shopify/Order/')) {
    return { ok: false, reason: 'invalid-order-id' };
  }
  try {
    const components = selected.map(s => ({
      sku: s.sku,
      tier: s.tier,
      product_title: s.productTitle,
      variant_id: s.variantId,
    }));
    const res = await shopifyGraphQL(`
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key }
          userErrors { field message code }
        }
      }
    `, {
      metafields: [{
        ownerId: orderId,
        namespace: 'custom',
        key: 'mystery_box_components',
        type: 'json',
        value: JSON.stringify({ components, written_at: new Date().toISOString() }),
      }],
    });
    const errs = res.data?.metafieldsSet?.userErrors || [];
    if (errs.length) throw new Error(JSON.stringify(errs));
    console.log(`[components-metafield] ${orderId}: wrote ${components.length} SKUs`);
    return { ok: true, count: components.length };
  } catch (err) {
    console.error(`[components-metafield] ${orderId} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// --- ShipStation push (Option A: Shopify -> ShipStation -> SkuVault) ---------
// Upserts the order in ShipStation with the full line-item array including
// component SKUs at $0. Uses the createorder endpoint which acts as create-or-
// update when keyed by orderNumber. Pulls credentials from env, no-ops if unset.
async function pushComponentsToShipStation(orderName, parentSku, parentPrice, selected) {
  const KEY = process.env.SHIPSTATION_API_KEY;
  const SECRET = process.env.SHIPSTATION_API_SECRET;
  const STORE_ID = process.env.SHIPSTATION_STORE_ID; // optional, scopes to a specific store connection
  if (!KEY || !SECRET) {
    console.warn('[shipstation] credentials not set — skipping push');
    return { ok: false, reason: 'no-credentials' };
  }
  try {
    const auth = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
    // Build items array: parent at full price + components at $0.
    const items = [
      { sku: parentSku, name: 'EP Jewels Mystery Box', quantity: 1, unitPrice: parentPrice },
      ...selected.map(s => ({
        sku: s.sku,
        name: s.productTitle || s.sku,
        quantity: 1,
        unitPrice: 0,
        adjustment: false,
      })),
    ];
    const body = {
      orderNumber: orderName, // e.g. "#75147"
      orderStatus: 'awaiting_shipment',
      items,
      ...(STORE_ID ? { advancedOptions: { storeId: parseInt(STORE_ID, 10) } } : {}),
    };
    const r = await fetch('https://ssapi.shipstation.com/orders/createorder', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j)}`);
    console.log(`[shipstation] ${orderName}: pushed ${selected.length} components (orderId=${j.orderId})`);
    return { ok: true, shipstation_order_id: j.orderId };
  } catch (err) {
    console.error(`[shipstation] ${orderName} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// --- SkuVault push (Option B/C: Shopify -> SkuVault, parallel or master) -----
// Adds component SKUs to the SkuVault sales order keyed by Shopify order
// number. Uses Tenant+User token auth. No-ops if credentials unset.
async function pushComponentsToSkuVault(orderName, selected) {
  const TENANT = process.env.SKUVAULT_TENANT_TOKEN;
  const USER = process.env.SKUVAULT_USER_TOKEN;
  if (!TENANT || !USER) {
    console.warn('[skuvault] credentials not set — skipping push');
    return { ok: false, reason: 'no-credentials' };
  }
  try {
    // SkuVault's "Add Items to Sales Order" endpoint pattern. The exact endpoint
    // path may need adjustment based on the account's API doc — verify before
    // enabling. Reference: app.skuvault.com/dev/api
    const body = {
      TenantToken: TENANT,
      UserToken: USER,
      SaleId: orderName, // Shopify order name like "#75147"
      Items: selected.map(s => ({
        Sku: s.sku,
        Quantity: 1,
        UnitPrice: 0,
      })),
    };
    const r = await fetch('https://app.skuvault.com/api/sales/addItemsToSale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || (j.Errors && j.Errors.length)) {
      throw new Error(`HTTP ${r.status}: ${JSON.stringify(j)}`);
    }
    console.log(`[skuvault] ${orderName}: pushed ${selected.length} components`);
    return { ok: true };
  } catch (err) {
    console.error(`[skuvault] ${orderName} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Append assigned component SKUs to the order as real variant line items,
// then apply a 100% line-item discount so net order value is unchanged. This
// gives ShipStation actionable line items for pick tickets and barcode
// scanning while keeping the parent Mystery Box line intact for accounting.
// Requires the write_order_edits scope.
async function addOrderComponentLineItems(orderId, selected) {
  if (!orderId || !orderId.startsWith('gid://shopify/Order/')) {
    console.warn(`[order-edit] skipping — invalid orderId: ${orderId}`);
    return { ok: false, reason: 'invalid-order-id' };
  }
  try {
    const beginRes = await shopifyGraphQL(`
      mutation($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `, { id: orderId });
    const beginErrs = beginRes.data?.orderEditBegin?.userErrors || [];
    if (beginErrs.length) throw new Error(`orderEditBegin: ${JSON.stringify(beginErrs)}`);
    const calculatedOrderId = beginRes.data.orderEditBegin.calculatedOrder.id;

    const added = [];
    for (const item of selected) {
      const addRes = await shopifyGraphQL(`
        mutation($id: ID!, $variantId: ID!, $quantity: Int!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
            calculatedLineItem { id }
            userErrors { field message }
          }
        }
      `, { id: calculatedOrderId, variantId: item.variantId, quantity: 1 });
      const addErrs = addRes.data?.orderEditAddVariant?.userErrors || [];
      if (addErrs.length) throw new Error(`orderEditAddVariant ${item.sku}: ${JSON.stringify(addErrs)}`);
      const lineItemId = addRes.data.orderEditAddVariant.calculatedLineItem.id;

      const discRes = await shopifyGraphQL(`
        mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
          orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
            calculatedLineItem { id }
            userErrors { field message }
          }
        }
      `, {
        id: calculatedOrderId,
        lineItemId,
        discount: { percentValue: 100, description: 'Mystery Box component (included)' },
      });
      const discErrs = discRes.data?.orderEditAddLineItemDiscount?.userErrors || [];
      if (discErrs.length) throw new Error(`orderEditAddLineItemDiscount ${item.sku}: ${JSON.stringify(discErrs)}`);
      added.push(item.sku);
    }

    const commitRes = await shopifyGraphQL(`
      mutation($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
          order { id }
          userErrors { field message }
        }
      }
    `, {
      id: calculatedOrderId,
      notifyCustomer: false,
      staffNote: `Auto-added ${added.length} Mystery Box component SKUs`,
    });
    const commitErrs = commitRes.data?.orderEditCommit?.userErrors || [];
    if (commitErrs.length) throw new Error(`orderEditCommit: ${JSON.stringify(commitErrs)}`);

    console.log(`[order-edit] ${orderId}: added ${added.length} component line items (${added.join(', ')})`);
    return { ok: true, added };
  } catch (err) {
    console.error(`[order-edit] ${orderId} FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Decrement mb_remaining for every selected variant. Returns per-SKU result list.
// Failures are logged but do not throw — the order is already placed; manual
// reconciliation is preferable to surfacing a 500 to the merchant.
async function decrementCaps(selected) {
  const results = [];
  for (const item of selected) {
    try {
      const r = await decrementMbRemaining(item);
      console.log(`[mb_remaining] ${r.sku}: ${r.previous} -> ${r.current} (attempts=${r.attempts})`);
      results.push({ ...r, ok: true });
    } catch (err) {
      console.error(`[mb_remaining] FAILED ${item.sku}: ${err.message}`);
      results.push({ sku: item.sku, variantId: item.variantId, ok: false, error: err.message });
    }
  }
  return results;
}

// Detect a SKU's metal: 'gold' | 'silver' | 'both' (two-tone) | 'unknown'.
// Order matters: two-tone is checked before single-metal patterns.
function detectSkuMetal(sku) {
  if (/-TT(-|$)/.test(sku) || /-2TNE(-|$)/.test(sku)) return 'both';
  if (/-GLD(-\d+)?$/.test(sku) || /-G$/.test(sku) || /-GLD-/.test(sku)) return 'gold';
  if (/-SLVR(-\d+)?$/.test(sku) || /-S$/.test(sku) || /-SLVR-/.test(sku)) return 'silver';
  return 'unknown';
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

  const filterSorority = (pool) => {
    if (!sorority || sorority === 'N/A') return pool.filter(s => !s.sku.startsWith('N/SRTY'));
    return pool;
  };

  // Strip ring SKUs when customer opted out of rings ("N/A" ring size).
  // The remaining non-ring SKUs in tier3 (necklaces, bracelets, earrings)
  // fill the tier3 slot instead.
  const filterRings = (pool) => {
    if (ringSize === 'N/A') return pool.filter(s => !s.sku.startsWith('R/'));
    return pool;
  };

  // Main pool: drop bonus items (hats/cases) — those are add-ins, not main slots.
  const stripBonus = (pool) => pool.filter(s => !s.isBonus);

  const t1 = stripBonus(filterRings(filterEarrings(tier1Pool)));
  const t2 = stripBonus(filterRings(filterEarrings(filterSorority(tier2Pool))));
  const t3 = stripBonus(filterRings(filterEarrings(tier3Pool)));

  // Bonus pool: hats + cases across all tiers (per spec, these are add-in items
  // that ship in addition to the main pieces — 2pc box ships 3 items, etc.).
  const bonusPool = [...tier1Pool, ...tier2Pool, ...tier3Pool].filter(s => s.isBonus);

  const selected = [];
  const usedProductTypes = new Set();
  const usedProductIds = new Set();

  // Nearest-neighbor ring scoring. Exact > adjacent > nearby > miss. Only applies
  // to ring SKUs (R/*) — necklaces/earrings/etc. score 0 on this dimension.
  const ringNearestScore = (sku, size) => {
    if (!sku.startsWith('R/')) return 0;
    const s = parseInt(size, 10);
    if (Number.isNaN(s)) return 0;
    const ringWeights = [10, 7, 4, 2]; // delta 0..3
    for (let d = 0; d < ringWeights.length; d++) {
      if (skuMatchesRingSize(sku, String(s + d))) return ringWeights[d];
      if (d > 0 && s - d > 0 && skuMatchesRingSize(sku, String(s - d))) return ringWeights[d];
    }
    return 0;
  };

  // Weighted preference scoring. Higher = better match. Letter > number > ring.
  const scoreCandidate = (s) => {
    let score = 0;
    if (letter && skuMatchesLetter(s.sku, letter)) score += 100;
    if (luckyNumber && skuMatchesNumber(s.sku, luckyNumber)) score += 50;
    if (ringSize) score += ringNearestScore(s.sku, ringSize);
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
  const sportKeyword = 'RANGR';
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

  // Bonus add-in: pick one hat or case at random (per spec). Doesn't count
  // toward expectedTotal — ships in addition to the main pieces.
  const bonusCandidates = bonusPool.filter(s => !usedProductIds.has(s.productId));
  if (bonusCandidates.length > 0) {
    const bonusPick = bonusCandidates[Math.floor(Math.random() * bonusCandidates.length)];
    usedProductIds.add(bonusPick.productId);
    selected.push({ ...bonusPick, tier: 'bonus', reason: 'add-in' });
  }

  if (dryRun) {
    console.log('[dry-run] skipping cap decrement');
  } else if (selected.length > 0 && shortfalls.length === 0) {
    const capResults = await decrementCaps(selected);
    const failed = capResults.filter(r => !r.ok);
    if (failed.length) {
      console.warn(`[mb_remaining] ${failed.length}/${capResults.length} cap updates failed — manual review needed`);
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
app.post('/assign', requireEngineSecret, async (req, res) => {
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

    const packSlip = selected.map((s, i) => {
      const label = s.tier === 'bonus' ? 'BONUS ADD-IN' : s.tier.toUpperCase();
      return `${i + 1}. [${label}] ${s.productTitle} - SKU: ${s.sku}`;
    }).join('\n');

    const mainItems = selected.filter(s => s.tier !== 'bonus');
    const bonusItems = selected.filter(s => s.tier === 'bonus');
    const isShort = shortfalls.length > 0;
    const finalTag = isShort ? 'mb-manual-review' : (dryRun ? 'mb-dry-run' : 'mb-ready-to-pack');

    // Warehouse target controls where the component SKU breakdown is pushed.
    // The Shopify order itself ALWAYS stays clean (parent line only) once we
    // move off 'shopify-line-items'. Universally we still write the metafield
    // + the human-readable pack slip note + the status tag.
    //   'shopify-line-items' (legacy): adds components to Shopify order (LEAKS to customers — keep only for testing)
    //   'shipstation': pushes components to ShipStation via API (customer-safe)
    //   'skuvault':    pushes components to SkuVault via API (customer-safe)
    //   'none':        no warehouse push (note + metafield only, manual fallback)
    const WAREHOUSE_TARGET = (process.env.WAREHOUSE_TARGET || 'shopify-line-items').toLowerCase();

    let orderEdit = null;
    let orderWrite = null;
    let componentsMetafield = null;
    let warehousePush = null;
    if (!dryRun) {
      // Always write the structured metafield — customer-invisible, useful for any consumer.
      componentsMetafield = await writeOrderComponentsMetafield(order_id, selected);

      // Branch on warehouse target.
      if (WAREHOUSE_TARGET === 'shopify-line-items') {
        orderEdit = await addOrderComponentLineItems(order_id, selected);
      } else if (WAREHOUSE_TARGET === 'shipstation') {
        const orderName = (order_id.match(/Order\/(\d+)/) || [])[1] || order_id;
        warehousePush = await pushComponentsToShipStation(`#${orderName}`, `MB-${box_size.replace(' Piece', 'PC').replace(' ', '')}`, 0, selected);
      } else if (WAREHOUSE_TARGET === 'skuvault') {
        const orderName = (order_id.match(/Order\/(\d+)/) || [])[1] || order_id;
        warehousePush = await pushComponentsToSkuVault(`#${orderName}`, selected);
      }
      // 'none' falls through — pack slip in note is the only warehouse-facing artifact.

      orderWrite = await writeOrderNoteAndTag(order_id, packSlip, finalTag);
    }

    res.json({
      success: !isShort,
      dry_run: dryRun,
      tag: finalTag,
      selected_skus: selected.map(s => s.sku),
      pack_slip: packSlip,
      expected_total: expectedTotal,
      actual_main_total: mainItems.length,
      bonus_count: bonusItems.length,
      shortfalls,
      warehouse_target: WAREHOUSE_TARGET,
      order_edit: orderEdit,
      warehouse_push: warehousePush,
      components_metafield: componentsMetafield,
      order_write: orderWrite,
      order_id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Availability endpoint --------------------------------------------------
//
// Called on every PDP field change, so it must be fast. Backed by an in-memory
// pool cache keyed by (tier, metal) with a 60-second TTL. After /assign runs
// and decrements mb_remaining, the cached pools stay slightly stale for up to 60s —
// acceptable because availability is advisory; the engine itself re-reads
// fresh metafields before each real assignment.

const POOL_CACHE = new Map(); // key: `${tier}|${metal}` -> { pool, expiresAt }
const POOL_CACHE_TTL_MS = 60 * 1000;

async function getCachedEligibleSKUs(tier, metal) {
  const key = `${tier}|${metal}`;
  const hit = POOL_CACHE.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.pool;
  const pool = await getEligibleSKUs(tier, metal);
  POOL_CACHE.set(key, { pool, expiresAt: Date.now() + POOL_CACHE_TTL_MS });
  return pool;
}

const BOX_COMPOSITIONS = {
  '2 Piece': { tier1: 0, tier2: 2, tier3: 0 },
  '4 Piece': { tier1: 1, tier2: 2, tier3: 1 },
  '6 Piece': { tier1: 1, tier2: 2, tier3: 3 },
};

app.post('/availability', async (req, res) => {
  try {
    const { preferences, box_size } = req.body || {};
    if (!preferences || !box_size) {
      return res.status(400).json({ available: false, reason: 'missing preferences or box_size' });
    }
    const composition = BOX_COMPOSITIONS[box_size];
    if (!composition) {
      return res.json({ available: false, reason: `unknown box size: ${box_size}` });
    }
    const { metal, earrings, sorority, ringSize } = preferences;
    if (metal !== 'Yellow Gold' && metal !== 'Silver') {
      return res.json({ available: false, reason: 'metal must be "Yellow Gold" or "Silver"' });
    }

    const [t1Pool, t2Pool, t3Pool] = await Promise.all([
      getCachedEligibleSKUs('tier-1', metal),
      getCachedEligibleSKUs('tier-2', metal),
      getCachedEligibleSKUs('tier-3', metal),
    ]);

    // Mirror assignBox filtering exactly: strip earrings if customer said no,
    // strip sorority necklaces when N/A, strip rings if customer opted out,
    // drop hat/case bonus items from main pool.
    const filterEarrings = pool => earrings === 'No' ? pool.filter(s => !skuIsEarring(s.sku)) : pool;
    const filterSorority = pool => (!sorority || sorority === 'N/A') ? pool.filter(s => !s.sku.startsWith('N/SRTY')) : pool;
    const filterRings = pool => ringSize === 'N/A' ? pool.filter(s => !s.sku.startsWith('R/')) : pool;
    const stripBonus = pool => pool.filter(s => !s.isBonus);

    const t1 = stripBonus(filterRings(filterEarrings(t1Pool)));
    const t2 = stripBonus(filterRings(filterEarrings(filterSorority(t2Pool))));
    const t3 = stripBonus(filterRings(filterEarrings(t3Pool)));

    // Engine dedupes picks by productId, so the meaningful count per tier is
    // the number of distinct productIds — not the raw variant count.
    const distinctProducts = pool => new Set(pool.map(s => s.productId)).size;
    const counts = { tier1: distinctProducts(t1), tier2: distinctProducts(t2), tier3: distinctProducts(t3) };

    // Per-option availability — which dropdown values still have at least one
    // eligible SKU. Used by the customizer to disable sold-out options live.
    // Computed against the merged main pool, ignoring earrings/sorority filters
    // since those are the dimensions we're surfacing.
    const fullPool = [...t1Pool, ...t2Pool, ...t3Pool].filter(s => !s.isBonus);
    const SOR_MAP = {
      'Alpha Chi Omega': 'AChiO', 'Alpha Delta Pi': 'ADeltaP', 'Alpha Omicron Pi': 'AOmicronP',
      'Alpha Phi': 'APhi', 'Chi Omega': 'COmega', 'Delta Delta Delta': 'DDeltaD',
      'Delta Gamma': 'DGamma', 'Delta Zeta': 'DZeta', 'Kappa Alpha Theta': 'KAlphaT',
      'Kappa Delta': 'KDelta', 'Kappa Kappa Gamma': 'KKappaG', 'Pi Beta Phi': 'PBetaP',
      'Sigma Sigma Sigma': 'SSigmaS', 'Zeta Tau Alpha': 'ZTauA',
    };
    const anyMatch = (pred) => fullPool.some(s => pred(s.sku));
    const options = {
      letter: Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(L =>
        [L, anyMatch(sku => skuMatchesLetter(sku, L))])),
      ringSize: Object.fromEntries('2,3,4,5,6,7,8,9,10'.split(',').map(N =>
        [N, anyMatch(sku => sku.startsWith('R/') && skuMatchesRingSize(sku, N))])),
      luckyNumber: Object.fromEntries('0,1,2,3,4,5,6,7,8,9'.split(',').map(N =>
        [N, anyMatch(sku => skuMatchesNumber(sku, N))])),
      religious: {
        'N/A': true,
        'Cross': anyMatch(sku => sku.includes('CRS')),
        'Star of David': anyMatch(sku => sku.includes('STR-DAV') || sku.includes('CHAI')),
      },
      sports: {
        'N/A': true,
        'NY Rangers': anyMatch(sku => sku.includes('RANGR')),
      },
      sorority: {
        'N/A': true,
        ...Object.fromEntries(Object.entries(SOR_MAP).map(([name, code]) =>
          [name, anyMatch(sku => sku.includes(code))])),
      },
    };

    for (const tier of ['tier1', 'tier2', 'tier3']) {
      if (counts[tier] < composition[tier]) {
        return res.json({
          available: false,
          reason: `not enough ${tier} inventory for ${box_size} (have ${counts[tier]}, need ${composition[tier]})`,
          counts,
          required: composition,
          options,
        });
      }
    }

    return res.json({ available: true, counts, required: composition, options });
  } catch (err) {
    console.error('[availability] error:', err);
    return res.status(500).json({ available: false, reason: `server error: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mystery box engine running on port ${PORT}`);
});