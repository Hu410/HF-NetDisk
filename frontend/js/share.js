import { escapeHtml as esc, formatBytes as size } from './utils/format.js';

const content=document.querySelector('#share-content');
const pathId=location.pathname.match(/^\/s\/([A-Za-z0-9]{8}|[a-f0-9]{32})\/?$/)?.[1];
const id=pathId||new URLSearchParams(location.search).get('id')||'';
let folderShare=null;
let currentDirectory='';

function date(value){ return value?new Date(value).toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'short'}):'永久有效'; }

async function request(path,options={}){
  const response=await fetch(path,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok){ const error=new Error(data.error||'请求失败'); error.status=response.status; error.code=data.code; throw error; }
  return data;
}

async function load(){
  if(!/^(?:[A-Za-z0-9]{8}|[a-f0-9]{32})$/.test(id)){ renderError('分享链接无效','请检查链接是否完整。'); return; }
  try{
    const { share }=await request(`/api/public/shares/${id}`);
    if(share.locked) renderUnlock(share);
    else renderShare(share);
  }catch(error){
    if(error.status===410) renderError('分享已过期','请联系分享者重新创建链接。');
    else if(error.status===404) renderError('分享不存在','链接可能已被撤销或输入有误。');
    else renderError('暂时无法访问',error.message);
  }
}

function renderUnlock(share){
  content.innerHTML=`<div class="share-owner"><span class="share-owner-avatar">HF</span><div><strong>来自 HF Drive 的分享</strong><small>请验证密码后查看内容</small></div></div><div class="share-public-icon">${share.type==='directory'?'📁':'📄'}</div><h1>${esc(share.name)}</h1>
    <p class="share-public-subtitle"><span class="secure-dot"></span> 此分享受密码保护</p>
    <form id="share-unlock-form" class="share-unlock-form"><label for="share-access-password">访问密码</label><input class="form-input" id="share-access-password" type="password" required autofocus autocomplete="current-password" placeholder="请输入访问密码"><div class="share-access-error" id="share-access-error"></div><button class="btn btn-primary" type="submit">查看分享</button></form>
    <div class="share-public-expiry">有效期至：${share.expiresAt?date(share.expiresAt):'永久'}</div>`;
  document.querySelector('#share-unlock-form').addEventListener('submit',unlock);
}

async function unlock(event){
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'),errorNode=document.querySelector('#share-access-error');
  button.disabled=true; button.textContent='验证中...'; errorNode.textContent='';
  try{
    await request(`/api/public/shares/${id}/access`,{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ password:document.querySelector('#share-access-password').value }) });
    await load();
  }catch(error){
    errorNode.textContent=error.status===429?'尝试次数过多，请稍后再试':error.message;
    button.disabled=false; button.textContent='查看分享';
  }
}

function renderShare(share){
  const header=`<div class="share-public-icon">${share.type==='directory'?'📁':'📄'}</div><h1>${esc(share.name)}</h1><div class="share-public-expiry">${share.expiresAt?`有效期至：${date(share.expiresAt)}`:'永久有效'}</div>`;
  if(share.type==='file'){
    folderShare=null;
    content.innerHTML=`<div class="share-owner"><span class="share-owner-avatar">HF</span><div><strong>来自 HF Drive 的分享</strong><small>安全云端传输</small></div></div>${header}<div class="share-single-file"><span class="share-file-tile">📄</span><div><strong>${esc(share.name)}</strong><small>${size(share.size)}</small></div><a class="btn btn-primary share-download-button" href="/api/public/shares/${id}/download"><span aria-hidden="true">↓</span> 下载</a></div>`;
    return;
  }
  folderShare=share;
  currentDirectory='';
  renderFolderDirectory();
}

function renderFolderDirectory(){
  if(!folderShare)return;
  const files=folderShare.files||[],explicitDirectories=folderShare.directories||[];
  const prefix=currentDirectory?`${currentDirectory}/`:'';
  const directories=new Set();
  const visibleFiles=[];
  for(const directory of explicitDirectories){
    if(!directory.startsWith(prefix))continue;
    const remainder=directory.slice(prefix.length);
    if(remainder)directories.add(remainder.split('/')[0]);
  }
  for(const file of files){
    if(!file.path.startsWith(prefix))continue;
    const remainder=file.path.slice(prefix.length);
    const separator=remainder.indexOf('/');
    if(separator>=0)directories.add(remainder.slice(0,separator));
    else visibleFiles.push(file);
  }
  const parts=currentDirectory?currentDirectory.split('/'):[];
  let accumulated='';
  const breadcrumb=[`<button class="share-breadcrumb-item ${parts.length?'':'current'}" data-share-dir="">${esc(folderShare.name)}</button>`];
  parts.forEach((part,index)=>{
    accumulated=accumulated?`${accumulated}/${part}`:part;
    breadcrumb.push('<span>›</span>',`<button class="share-breadcrumb-item ${index===parts.length-1?'current':''}" data-share-dir="${encodeURIComponent(accumulated)}">${esc(part)}</button>`);
  });
  const directoryRows=[...directories].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(name=>{
    const path=currentDirectory?`${currentDirectory}/${name}`:name;
    return `<div class="share-public-file share-public-directory" data-share-dir="${encodeURIComponent(path)}" tabindex="0"><span class="share-file-icon folder-tile">📁</span><div class="share-file-info"><strong>${esc(name)}</strong><small>文件夹 · 双击进入</small></div><span class="share-directory-arrow">›</span></div>`;
  });
  const fileRows=visibleFiles.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')).map(file=>`<div class="share-public-file"><span class="share-file-icon file-tile">📄</span><div class="share-file-info"><strong>${esc(file.name)}</strong><small>${size(file.size)}${file.lastModified?` · ${date(file.lastModified)}`:''}</small></div><a class="btn btn-sm btn-outline share-row-download" href="/api/public/shares/${id}/download?file=${encodeURIComponent(file.path)}">下载</a></div>`);
  const rows=[...directoryRows,...fileRows];
  const header=`<div class="share-public-icon">📁</div><h1>${esc(folderShare.name)}</h1><div class="share-public-expiry">${folderShare.expiresAt?`有效期至：${date(folderShare.expiresAt)}`:'永久有效'}</div>`;
  content.innerHTML=`<div class="share-owner"><span class="share-owner-avatar">HF</span><div><strong>来自 HF Drive 的分享</strong><small>安全云端传输</small></div></div>${header}<div class="share-folder-summary">共 ${files.length} 个文件${folderShare.truncated?'（列表仅显示前 1000 个）':''}</div><nav class="share-breadcrumb" aria-label="分享目录">${breadcrumb.join('')}</nav>
    ${rows.length?`<div class="share-public-files">${rows.join('')}</div>`:'<div class="empty-state"><div class="empty-icon">📂</div><h3>文件夹为空</h3></div>'}`;
}

function renderError(title,message){
  folderShare=null;
  content.innerHTML=`<div class="share-public-icon muted">⚠️</div><h1>${esc(title)}</h1><p class="share-public-subtitle">${esc(message)}</p>`;
}

content.addEventListener('dblclick',event=>{
  const directory=event.target.closest('.share-public-directory');
  if(!directory)return;
  currentDirectory=decodeURIComponent(directory.dataset.shareDir);
  renderFolderDirectory();
});
content.addEventListener('click',event=>{
  const breadcrumb=event.target.closest('.share-breadcrumb-item');
  if(!breadcrumb)return;
  currentDirectory=decodeURIComponent(breadcrumb.dataset.shareDir);
  renderFolderDirectory();
});

load();
