#!/usr/bin/env node
/**
 * Concurrency load test for /assign.
 *
 * Default: fires 50 parallel DRY-RUN requests against the live endpoint to
 * prove the server handles burst load without crashing and without skewing
 * cap counts. Measures latency p50/p95/max and success rate.
 *
 * Optional: --real fires 5 parallel REAL (non-dry) requests to exercise the
 * optimistic-concurrency cap decrement path. This WILL increment mb_used on
 * real SKUs. Only run if you intend to verify true concurrency behavior.
 *
 * Usage:
 *   node load-test-assign.js                # 50 dry-runs
 *   node load-test-assign.js --concurrent=100  # custom count
 *   node load-test-assign.js --real         # 5 real assignments (touches inventory)
 */

const URL_BASE = 'https://ep-jewels-mystery-box.onrender.com/assign';
const ENGINE_SECRET = process.env.ENGINE_SECRET;
if (!ENGINE_SECRET) {
  console.error('ENGINE_SECRET env var required. Get it from Render dashboard env tab.');
  process.exit(1);
}

const args = process.argv.slice(2);
const REAL = args.includes('--real');
const N = (() => {
  const a = args.find(x => x.startsWith('--concurrent='));
  if (a) return parseInt(a.split('=')[1], 10);
  return REAL ? 5 : 50;
})();

// Sample preference combos to spread across requests. Cycling these makes
// the test more realistic (different metals, sorority, religious, etc.).
const SAMPLE_PREFS = [
  { metal: 'Yellow Gold', letter: 'E', luckyNumber: '7', ringSize: '7', earrings: 'Yes', religious: 'Cross', sports: 'N/A', sorority: 'N/A' },
  { metal: 'Yellow Gold', letter: 'A', luckyNumber: '5', ringSize: '6', earrings: 'No',  religious: 'N/A',   sports: 'N/A', sorority: 'Alpha Phi' },
  { metal: 'Silver',      letter: 'M', luckyNumber: '3', ringSize: '8', earrings: 'Yes', religious: 'Star of David', sports: 'N/A', sorority: 'N/A' },
  { metal: 'Yellow Gold', letter: 'R', luckyNumber: '9', ringSize: '8', earrings: 'Yes', religious: 'N/A',   sports: 'NY Rangers', sorority: 'N/A' },
  { metal: 'Yellow Gold', letter: 'S', luckyNumber: '2', ringSize: '7', earrings: 'Yes', religious: 'N/A',   sports: 'N/A', sorority: 'N/A' },
];
const BOX_SIZES = ['2 Piece', '4 Piece', '6 Piece'];

function pickRand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function fireOne(i) {
  const start = performance.now();
  const url = REAL ? URL_BASE : `${URL_BASE}?dry=1`;
  const payload = {
    order_id: `loadtest-${REAL ? 'REAL' : 'dry'}-${Date.now()}-${i}`,
    box_size: pickRand(BOX_SIZES),
    preferences: pickRand(SAMPLE_PREFS),
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENGINE_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    const elapsed = performance.now() - start;
    const json = await r.json();
    return {
      ok: r.ok && json.success === true,
      status: r.status,
      tag: json.tag,
      sku_count: json.selected_skus ? json.selected_skus.length : 0,
      ms: elapsed,
      err: r.ok ? null : (json.error || `HTTP ${r.status}`),
    };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - start, err: e.message };
  }
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

(async () => {
  console.log(`\nFiring ${N} parallel ${REAL ? 'REAL' : 'dry-run'} requests to /assign...\n`);
  if (REAL) {
    console.log('⚠️  WARNING: --real will increment mb_used on real SKUs.');
    console.log('   Press Ctrl-C in the next 3 seconds to abort.\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => fireOne(i)));
  const total = performance.now() - t0;

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const latencies = results.map(r => r.ms);

  console.log('--- Results ---');
  console.log(`  Total wall time:    ${total.toFixed(0)} ms`);
  console.log(`  Successful:         ${ok.length}/${N}`);
  console.log(`  Failed:             ${failed.length}/${N}`);
  console.log(`  Latency p50:        ${pct(latencies, 0.5).toFixed(0)} ms`);
  console.log(`  Latency p95:        ${pct(latencies, 0.95).toFixed(0)} ms`);
  console.log(`  Latency max:        ${Math.max(...latencies).toFixed(0)} ms`);
  console.log('');

  const tagCounts = {};
  ok.forEach(r => { tagCounts[r.tag] = (tagCounts[r.tag] || 0) + 1; });
  console.log('  Tag distribution:');
  Object.entries(tagCounts).forEach(([t, c]) => console.log(`    ${t}: ${c}`));

  const skuCounts = {};
  ok.forEach(r => { skuCounts[r.sku_count] = (skuCounts[r.sku_count] || 0) + 1; });
  console.log('  SKU-count distribution:');
  Object.entries(skuCounts).sort().forEach(([n, c]) => console.log(`    ${n} SKUs: ${c}`));

  if (failed.length) {
    console.log('\n  Failures:');
    failed.slice(0, 10).forEach(f => console.log(`    [${f.status}] ${f.err}`));
    if (failed.length > 10) console.log(`    ... and ${failed.length - 10} more`);
  }

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
})();
