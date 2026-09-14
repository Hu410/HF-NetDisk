import process from 'node:process';

try { process.loadEnvFile('.integration.vars'); } catch { /* Optional local config. */ }
const baseUrl = process.env.HF_NETDISK_BASE_URL || 'https://hf.relc.eu.org';
const started = performance.now();
const response = await fetch(new URL('/api/health', baseUrl), { headers: { 'User-Agent': 'HF-NetDisk-Healthcheck/1.0' } });
const body = await response.json().catch(() => ({}));
const result = { url: new URL('/api/health', baseUrl).toString(), status: response.status, latencyMs: Number((performance.now() - started).toFixed(1)), requestId: response.headers.get('x-request-id'), checks: body.checks };
console.log(JSON.stringify(result, null, 2));
if (!response.ok || body.status !== 'ok' || !Object.values(body.checks || {}).every(Boolean)) process.exitCode = 1;
