import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { withAuth } from '../middleware/auth.js';
import { contentDisposition, errorResponse, fileResponse, jsonResponse, successResponse } from '../utils/response.js';
import { randomAlphanumeric, sanitizePath } from '../utils/helpers.js';
import { createPasswordDigest } from '../utils/shareCrypto.js';
import { shareStoreRequest } from '../utils/shareStore.js';

const MAX_FOLDER_FILES = 1000;
const MAX_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

async function handleManagedShares(context) {
  const { request }=context;
  const url=new URL(request.url);
  if(url.pathname==='/api/shares' && request.method==='GET'){
    const page=Math.max(1,Number.parseInt(url.searchParams.get('page'),10)||1);
    const response=await shareStoreRequest(context.env,'/share/list',{ page,limit:20 });
    const data=await response.json();
    return successResponse({
      shares:data.shares.map(share=>({ ...share,url:`${url.origin}/s/${share.id}` })),
      pagination:data.pagination,
    });
  }
  if(url.pathname==='/api/shares' && request.method==='POST') return createShare(context);
  const match=url.pathname.match(/^\/api\/shares\/([A-Za-z0-9]{8}|[a-f0-9]{32})$/);
  if(match && request.method==='DELETE'){
    const response=await shareStoreRequest(context.env,'/share/delete',{ id:match[1] });
    if(!response.ok) return errorResponse('Share not found',404,null,'SHARE_NOT_FOUND');
    return successResponse({ id:match[1] },'Share revoked');
  }
  return errorResponse('Not found',404,null,'NOT_FOUND');
}

async function createShare(context) {
  const body=await context.request.json().catch(()=>({}));
  const path=sanitizePath(body.path);
  const type=body.type==='directory'?'directory':body.type==='file'?'file':null;
  if(!path || !type) return errorResponse('Invalid share path or type',400,null,'INVALID_SHARE');
  const password=String(body.password||'');
  if(password.length>128) return errorResponse('Password is too long',400,null,'INVALID_PASSWORD');
  const expiresIn=body.expiresIn===null || body.expiresIn===0 || body.expiresIn==='' ? null : Number(body.expiresIn);
  if(expiresIn!==null && (!Number.isInteger(expiresIn) || expiresIn<300 || expiresIn>MAX_EXPIRY_SECONDS)) {
    return errorResponse('Expiration must be between 5 minutes and 365 days',400,null,'INVALID_EXPIRATION');
  }
  const api=new HuggingFaceAPI(context.hfToken,context.hfRepo,context.hfIsPrivate,context.env);
  if(!await pathExists(api,path,type)) return errorResponse('File or folder not found',404,null,'PATH_NOT_FOUND');
  const createdAt=new Date().toISOString();
  const digest=await createPasswordDigest(password);
  const record={ path,name:path.split('/').pop(),type,createdAt,
    expiresAt:expiresIn===null?null:new Date(Date.now()+expiresIn*1000).toISOString(),...digest };
  let share=null;
  for(let attempt=0;attempt<5;attempt++){
    const response=await shareStoreRequest(context.env,'/share/create',{ ...record,id:randomAlphanumeric(8) });
    const data=await response.json().catch(()=>({}));
    if(response.ok){ share=data.share; break; }
    if(data.code!=='SHARE_ID_COLLISION') return errorResponse('Share limit reached',409,null,'SHARE_LIMIT');
  }
  if(!share) return errorResponse('Unable to create a unique share link',503,null,'SHARE_ID_UNAVAILABLE');
  const origin=new URL(context.request.url).origin;
  return jsonResponse({ success:true,message:'Share created',share:{ ...share,url:`${origin}/s/${share.id}` } },201);
}

async function handlePublicShares(context) {
  const { request }=context;
  const url=new URL(request.url);
  const match=url.pathname.match(/^\/api\/public\/shares\/([A-Za-z0-9]{8}|[a-f0-9]{32})(?:\/(access|download))?$/);
  if(!match) return errorResponse('Share not found',404,null,'SHARE_NOT_FOUND');
  const id=match[1], action=match[2]||'info';
  if(action==='access' && request.method==='POST') return unlockShare(context,id);
  if(action==='info' && request.method==='GET') return publicShareInfo(context,id);
  if(action==='download' && request.method==='GET') return publicShareDownload(context,id);
  return errorResponse('Method not allowed',405,null,'METHOD_NOT_ALLOWED');
}

async function getShare(env,id) {
  const response=await shareStoreRequest(env,'/share/get',{ id });
  if(!response.ok) return { error:errorResponse('Share not found',404,null,'SHARE_NOT_FOUND') };
  const { share }=await response.json();
  if(share.expiresAt && Date.parse(share.expiresAt)<=Date.now()) return { error:errorResponse('Share expired',410,null,'SHARE_EXPIRED') };
  return { share };
}

async function isAuthorized(request,env,share) {
  if(!share.passwordHash) return true;
  const token=readCookie(request,`hf_share_${share.id}`);
  if(!token) return false;
  const response=await shareStoreRequest(env,'/grant/verify',{ id:share.id,token });
  return response.ok && (await response.json()).valid===true;
}

async function unlockShare(context,id) {
  const body=await context.request.json().catch(()=>({}));
  const response=await shareStoreRequest(context.env,'/share/unlock',{
    id,password:String(body.password||''),clientKey:context.request.headers.get('CF-Connecting-IP')||'unknown',
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) return errorResponse(data.error||'Unable to unlock share',response.status,null,response.status===429?'TOO_MANY_ATTEMPTS':'SHARE_ACCESS_DENIED');
  const maxAge=Math.max(1,Math.floor((data.expiresAt-Date.now())/1000));
  return jsonResponse({ success:true,unlocked:true },200,{
    'Set-Cookie':`hf_share_${id}=${data.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    'Cache-Control':'no-store',
  });
}

async function publicShareInfo(context,id) {
  const result=await getShare(context.env,id);
  if(result.error) return result.error;
  const { share }=result;
  const base={ id:share.id,name:share.name,type:share.type,createdAt:share.createdAt,expiresAt:share.expiresAt,passwordProtected:Boolean(share.passwordHash) };
  if(!await isAuthorized(context.request,context.env,share)) return publicJson({ share:{ ...base,locked:true } });
  const api=new HuggingFaceAPI(context.env.HF_TOKEN,context.env.HF_REPO,context.env.HF_PRIVATE!=='false',context.env);
  if(share.type==='file'){
    const head=await api.getFileContent(share.path,false,null,'HEAD');
    if(!head.ok) return errorResponse('Shared file is no longer available',404,null,'SHARED_FILE_MISSING');
    return publicJson({ share:{ ...base,locked:false,size:Number(head.headers.get('Content-Length')||0),files:[] } });
  }
  const listing=await api.listDirectoryAllPages(share.path,true,{ serverRecursive:true });
  const files=listing.files.slice(0,MAX_FOLDER_FILES).map(file=>({
    path:file.path.slice(share.path.length+1),name:file.name,size:file.size||0,lastModified:file.lastModified||null,
  }));
  const directories=listing.directories.map(directory=>directory.path.slice(share.path.length+1)).filter(Boolean);
  return publicJson({ share:{ ...base,locked:false,files,directories,truncated:listing.files.length>MAX_FOLDER_FILES } });
}

async function publicShareDownload(context,id) {
  const result=await getShare(context.env,id);
  if(result.error) return result.error;
  const { share }=result;
  if(!await isAuthorized(context.request,context.env,share)) return errorResponse('Share password required',401,null,'SHARE_PASSWORD_REQUIRED');
  let targetPath=share.path;
  if(share.type==='directory'){
    const relative=sanitizePath(new URL(context.request.url).searchParams.get('file')||'');
    if(!relative) return errorResponse('A shared file path is required',400,null,'INVALID_FILE_PATH');
    targetPath=sanitizePath(`${share.path}/${relative}`);
    if(!targetPath || !targetPath.startsWith(`${share.path}/`)) return errorResponse('Invalid shared file path',400,null,'INVALID_FILE_PATH');
  }
  const api=new HuggingFaceAPI(context.env.HF_TOKEN,context.env.HF_REPO,context.env.HF_PRIVATE!=='false',context.env);
  const upstream=await api.getFileContent(targetPath,false,context.request.headers,'GET');
  if(!upstream.ok && upstream.status!==206) return errorResponse('Shared file is no longer available',404,null,'SHARED_FILE_MISSING');
  const headers=new Headers();
  for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges','ETag','Last-Modified']){
    const value=upstream.headers.get(name); if(value) headers.set(name,value);
  }
  headers.set('Content-Type',headers.get('Content-Type')||'application/octet-stream');
  headers.set('Content-Disposition',contentDisposition('attachment',targetPath.split('/').pop()||'download'));
  headers.set('Cache-Control','private, no-store');
  return fileResponse(upstream.body,{ status:upstream.status,headers });
}

async function pathExists(api,path,type) {
  const separator=path.lastIndexOf('/');
  const parent=separator>=0?path.slice(0,separator):'';
  let cursor=null;
  do{
    const listing=await api.listDirectory(parent,false,cursor?{ cursor }:{ });
    const collection=type==='directory'?listing.directories:listing.files;
    if(collection.some(item=>item.path===path)) return true;
    cursor=listing.nextCursor||null;
  }while(cursor);
  return false;
}

function readCookie(request,name) {
  for(const part of (request.headers.get('Cookie')||'').split(';')){
    const [key,...value]=part.trim().split('='); if(key===name) return value.join('=');
  }
  return null;
}

function publicJson(data) { return jsonResponse({ success:true,...data },200,{ 'Cache-Control':'no-store' }); }

const managedHandler=withAuth(handleManagedShares);
export function sharesHandler(context) {
  return new URL(context.request.url).pathname.startsWith('/api/public/shares/') ? handlePublicShares(context) : managedHandler(context);
}
