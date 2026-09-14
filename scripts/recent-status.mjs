import process from 'node:process';

try { process.loadEnvFile('.integration.vars'); } catch { /* Optional local secret file. */ }
const baseUrl=process.env.HF_NETDISK_BASE_URL, password=process.env.HF_NETDISK_PASSWORD;
if(!baseUrl||!password)process.exit(2);
const origin=new URL(baseUrl).origin;
const login=await fetch(new URL('/api/auth/login',baseUrl),{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password,remember:false})});
if(!login.ok)throw new Error(`Login failed: ${login.status}`);
const cookie=login.headers.get('set-cookie')?.split(';',1)[0];
const response=await fetch(new URL('/api/directory/list?recursive=true&expand=true',baseUrl),{headers:{Cookie:cookie}});
if(!response.ok)throw new Error(`Recent list failed: ${response.status}`);
const body=await response.json();
const files=body.files||[], dated=files.filter(file=>file.lastModified&&Number.isFinite(Date.parse(file.lastModified)));
const rootResponse=await fetch(new URL('/api/directory/list?recursive=false&expand=true',baseUrl),{headers:{Cookie:cookie}});
if(!rootResponse.ok)throw new Error(`Root list failed: ${rootResponse.status}`);
const rootBody=await rootResponse.json(), rootItems=[...(rootBody.directories||[]),...(rootBody.files||[])];
const rootDated=rootItems.filter(item=>item.lastModified&&Number.isFinite(Date.parse(item.lastModified)));
console.log(JSON.stringify({recursiveFiles:files.length,recursiveWithModificationTime:dated.length,rootItems:rootItems.length,rootWithModificationTime:rootDated.length,newest:dated.map(file=>file.lastModified).sort().at(-1)||null}));
if((files.length&&dated.length!==files.length)||(rootItems.length&&rootDated.length!==rootItems.length))process.exitCode=1;
