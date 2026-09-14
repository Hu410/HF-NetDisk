import process from 'node:process';

try { process.loadEnvFile('.integration.vars'); } catch { /* Local secret file is optional. */ }
const baseUrl = process.env.HF_NETDISK_BASE_URL;
const password = process.env.HF_NETDISK_PASSWORD;
if (!baseUrl || !password) process.exit(2);
const origin = new URL(baseUrl).origin;
const login = await fetch(new URL('/api/auth/login', baseUrl), {
  method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json' }, body:JSON.stringify({ password, remember:false }),
});
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
const response = await fetch(new URL('/api/trash/list', baseUrl), { headers:{ Cookie:cookie } });
if (!response.ok) throw new Error(`Trash list failed: ${response.status}`);
const body = await response.json();
console.log(JSON.stringify({ entries:(body.entries || []).length }));
