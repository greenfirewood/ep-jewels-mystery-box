#!/usr/bin/env node
/**
 * Updates the EP Jewels Mystery Box product with launch-ready content:
 *   - descriptionHtml (info callout + final-sale terms + bullet copy)
 *   - SEO title + description
 *   - productType
 *   - inventoryPolicy on all variants -> CONTINUE (won't go out-of-stock)
 *   - image altText
 *   - variant SKUs (MB-2PC / MB-4PC / MB-6PC for reporting hygiene)
 *   - product metafields the theme can read for the popup + final-sale block
 *
 * NEVER touches price, title, handle, status, publishedAt, or variant options.
 *
 * Dry-run by default. Use --execute to write.
 */

const PRODUCT_HANDLE = 'ep-jewels-mystery-box';
const SHOP = 'ep-the-label.myshopify.com';
const API = '2025-01';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');

async function getToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) { console.error(`Token fetch failed: ${r.status} ${await r.text()}`); process.exit(1); }
  return (await r.json()).access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// --- Content (pulled from your original spec) ---
const DESCRIPTION_HTML = `
<p><strong>EP Jewels Mystery Box</strong> — a curated surprise of our most-loved pieces, personalized to your style.</p>

<p>Choose your box size, then tell us your preferences. Every box is unique — same or similar inputs will not produce identical results.</p>

<p><em>Please note your mystery box may include some (not all) of your preferences above.</em></p>

<h3>Box Options</h3>
<ul>
  <li><strong>2 Piece Mystery Box</strong> — $124 (up to 42% off in savings)</li>
  <li><strong>4 Piece Mystery Box</strong> — $268 (up to 42% off in savings)</li>
  <li><strong>6 Piece Mystery Box</strong> — $374 (up to 42% off in savings)</li>
</ul>

<h3>The Fine Print</h3>
<ul>
  <li><strong>Final Sale</strong> — no returns or exchanges</li>
  <li>Only available while supplies last</li>
  <li>Up to <strong>56% off</strong> — the biggest savings you can get</li>
  <li>Boxes may include discontinued styles, overstock, samples, or unreleased designs</li>
  <li>Hats and jewelry cases ship as bonus add-in items on top of your chosen box size</li>
</ul>
`.trim();

const SEO_TITLE = 'EP Jewels Mystery Box — Up To 56% Off';
const SEO_DESCRIPTION = 'Personalized mystery boxes from EP Jewels. Choose your size and preferences (metal, letter, ring size, lucky number, religious, sports, sorority). Final sale, while supplies last.';
const PRODUCT_TYPE = 'Mystery Box';
const IMAGE_ALT = 'EP Jewels Mystery Box — curated jewelry surprise';

// Theme-readable metafields (if the theme picks them up, they'll render; otherwise harmless).
const METAFIELDS = [
  { namespace: 'mystery_box', key: 'preferences_note', type: 'single_line_text_field',
    value: 'Please note your mystery box may include some (not all) of your preferences above.' },
  { namespace: 'mystery_box', key: 'final_sale_confirmation', type: 'multi_line_text_field',
    value: 'I confirm this Mystery Box is Final Sale. Packages may include discontinued styles, overstock, samples, or unreleased designs. Final sale — no returns or exchanges. Only available while supplies last. Up to 56% off — the biggest savings you can get.' },
  { namespace: 'mystery_box', key: 'launch_iso', type: 'single_line_text_field',
    value: '2026-05-22T18:00:00Z' }, // 2 PM EST = 18:00 UTC
];

const VARIANT_SKUS = {
  '2 Piece': 'MB-2PC',
  '4 Piece': 'MB-4PC',
  '6 Piece': 'MB-6PC',
};

(async () => {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}\n`);
  const token = await getToken();

  // Fetch current state to compute deltas
  const current = await gql(token, `{
    productByHandle(handle: "${PRODUCT_HANDLE}") {
      id title descriptionHtml productType
      seo { title description }
      images(first: 5) { edges { node { id altText } } }
      variants(first: 10) { edges { node { id title sku inventoryPolicy } } }
      metafields(first: 50) { edges { node { id namespace key } } }
    }
  }`);

  const p = current.productByHandle;
  if (!p) { console.error('Product not found.'); process.exit(1); }

  const plan = [];
  if (p.descriptionHtml !== DESCRIPTION_HTML) plan.push('descriptionHtml');
  if (p.seo.title !== SEO_TITLE) plan.push('seo.title');
  if (p.seo.description !== SEO_DESCRIPTION) plan.push('seo.description');
  if (p.productType !== PRODUCT_TYPE) plan.push('productType');
  for (const img of p.images.edges) {
    if (img.node.altText !== IMAGE_ALT) plan.push(`image.altText[${img.node.id}]`);
  }
  for (const v of p.variants.edges) {
    const wantSku = VARIANT_SKUS[v.node.title];
    if (wantSku && v.node.sku !== wantSku) plan.push(`variant.sku[${v.node.title}] -> ${wantSku}`);
    if (v.node.inventoryPolicy !== 'CONTINUE') plan.push(`variant.inventoryPolicy[${v.node.title}] -> CONTINUE`);
  }
  for (const m of METAFIELDS) {
    const exists = p.metafields.edges.find(e => e.node.namespace === m.namespace && e.node.key === m.key);
    plan.push(`metafield.${m.namespace}.${m.key} ${exists ? '(overwrite)' : '(create)'}`);
  }

  console.log(`Planned writes: ${plan.length}`);
  plan.forEach(p => console.log('  - ' + p));
  console.log('');

  if (!EXECUTE) { console.log('Dry-run complete. Re-run with --execute to apply.'); return; }

  // Apply: productUpdate covers description, SEO, productType, metafields.
  // (Images are no longer on ProductInput in 2025-01 — separate fileUpdate below.)
  const updateRes = await gql(token, `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: p.id,
      descriptionHtml: DESCRIPTION_HTML,
      productType: PRODUCT_TYPE,
      seo: { title: SEO_TITLE, description: SEO_DESCRIPTION },
      metafields: METAFIELDS.map(m => ({ namespace: m.namespace, key: m.key, type: m.type, value: m.value })),
    },
  });
  const updErrs = updateRes.productUpdate.userErrors;
  if (updErrs.length) { console.error('productUpdate errors:', updErrs); process.exit(1); }
  console.log('✓ productUpdate done');

  // Image alt text: re-query as `media` to get File IDs, then fileUpdate.
  const mediaRes = await gql(token, `{
    productByHandle(handle: "${PRODUCT_HANDLE}") {
      media(first: 10) { edges { node { ... on MediaImage { id alt } } } }
    }
  }`);
  const mediaNodes = (mediaRes.productByHandle.media.edges || [])
    .map(e => e.node).filter(n => n && n.id);
  if (mediaNodes.length) {
    const fileRes = await gql(token, `
      mutation($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { ... on MediaImage { id alt } }
          userErrors { field message }
        }
      }
    `, { files: mediaNodes.map(m => ({ id: m.id, alt: IMAGE_ALT })) });
    const fileErrs = fileRes.fileUpdate.userErrors;
    if (fileErrs.length) console.warn('fileUpdate errors (non-fatal):', fileErrs);
    else console.log(`✓ image alt text set on ${mediaNodes.length} file(s)`);
  }

  // Apply variant updates separately (productVariantsBulkUpdate)
  const variantInputs = p.variants.edges.map(v => ({
    id: v.node.id,
    sku: VARIANT_SKUS[v.node.title] ?? v.node.sku,
    inventoryPolicy: 'CONTINUE',
  }));
  const varRes = await gql(token, `
    mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku inventoryPolicy }
        userErrors { field message }
      }
    }
  `, { productId: p.id, variants: variantInputs });
  const varErrs = varRes.productVariantsBulkUpdate.userErrors;
  if (varErrs.length) { console.error('variant update errors:', varErrs); process.exit(1); }
  console.log('✓ variants updated');

  console.log('\nDone. Re-run the audit query to verify.');
})();
