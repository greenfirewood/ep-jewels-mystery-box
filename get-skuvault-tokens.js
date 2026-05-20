#!/usr/bin/env node
/**
 * Retrieve SkuVault API tokens (TenantToken + UserToken) via login credentials.
 *
 * Reads SKUVAULT_EMAIL and SKUVAULT_PASSWORD from env (or from CLI args
 * --email=... --password=...). DOES NOT log the password.
 *
 * Usage:
 *   SKUVAULT_EMAIL=evange@epjewels.co SKUVAULT_PASSWORD='...' node get-skuvault-tokens.js
 *   OR
 *   node get-skuvault-tokens.js --email=evange@epjewels.co --password='...'
 */
const args = process.argv.slice(2);
const flag = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');

const email = flag('email') || process.env.SKUVAULT_EMAIL;
const password = flag('password') || process.env.SKUVAULT_PASSWORD;

if (!email || !password) {
  console.error('Need email and password.');
  console.error('Set SKUVAULT_EMAIL + SKUVAULT_PASSWORD env vars, or pass --email=... --password=...');
  process.exit(1);
}

(async () => {
  try {
    const r = await fetch('https://app.skuvault.com/api/gettokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ Email: email, Password: password }),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = text; }
    if (!r.ok) {
      console.error(`HTTP ${r.status}:`, j);
      process.exit(1);
    }
    if (!j.TenantToken || !j.UserToken) {
      console.error('Unexpected response (no tokens):', j);
      process.exit(1);
    }
    console.log('\n✓ Got SkuVault tokens.\n');
    console.log(`SKUVAULT_TENANT_TOKEN=${j.TenantToken}`);
    console.log(`SKUVAULT_USER_TOKEN=${j.UserToken}`);
    console.log('\nAdd both to Render env vars, then set WAREHOUSE_TARGET=skuvault-and-shipstation (or whichever target we wire) and redeploy.\n');
  } catch (err) {
    console.error('Request failed:', err.message);
    process.exit(1);
  }
})();
