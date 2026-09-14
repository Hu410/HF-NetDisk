import process from 'node:process';
import { performance } from 'node:perf_hooks';

try { process.loadEnvFile('.integration.vars'); } catch { /* Optional local secret file. */ }

const baseUrl = process.env.HF_NETDISK_BASE_URL;
const password = process.env.HF_NETDISK_PASSWORD;
const concurrency = Math.max(1, Math.min(20, Number(process.env.HF_NETDISK_CONCURRENCY || 5)));
const requests = Math.max(concurrency, Math.min(1000, Number(process.env.HF_NETDISK_REQUESTS || 50)));
if (!baseUrl || !password) {
  console.error('Set HF_NETDISK_BASE_URL and HF_NETDISK_PASSWORD. This benchmark performs authenticated read-only requests.');
  process.exit(2);
}

const origin = new URL(baseUrl).origin;
const login = await fetch(new URL('/api/auth/login', baseUrl), {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password, remember: false }),
});
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
if (!cookie) throw new Error('Login response did not set a session cookie');

let cursor = 0;
const samples = [];
let failures = 0;
async function worker() {
  while (cursor < requests) {
    cursor += 1;
    const started = performance.now();
    try {
      const response = await fetch(new URL('/api/directory/list?limit=20', baseUrl), { headers: { Cookie: cookie } });
      if (!response.ok) throw new Error(String(response.status));
      await response.arrayBuffer();
      samples.push(performance.now() - started);
    } catch {
      failures += 1;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
samples.sort((a, b) => a - b);
const percentile = value => samples[Math.min(samples.length - 1, Math.floor(samples.length * value))] || 0;
console.log(JSON.stringify({ requests, concurrency, passed: samples.length, failures, latencyMs: {
  min: Number((samples[0] || 0).toFixed(1)), p50: Number(percentile(0.5).toFixed(1)),
  p95: Number(percentile(0.95).toFixed(1)), max: Number((samples.at(-1) || 0).toFixed(1)),
} }, null, 2));
if (failures) process.exitCode = 1;
