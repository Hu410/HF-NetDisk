import { expect, test } from '@playwright/test';

/* global document, window */

async function mockApi(page, authenticated = true, trashEntries = [], browseDirectories = false, recentTotalPages = 1) {
  const shareId = 'aB3dE5g7';
  let shares = [];
  let publicUnlocked = false;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let body = { success: true };
    if (url.pathname === '/api/auth/status') body.authenticated = authenticated;
    else if (url.pathname === '/api/auth/login') body.authenticated = true;
    else if (url.pathname === '/api/repo/info') {
      body.info = { id: 'owner/repo', private: true, size: { nbFiles: 1, sizeInBytes: 12 }, downloads: 0, likes: 0 };
    } else if (url.pathname === '/api/directory/recent') {
      const recentPage=Number(url.searchParams.get('page')||1);
      body.files=recentTotalPages===1
        ? [{name:'alpha.txt',path:'alpha.txt',type:'file',size:12,lastModified:'2026-08-30T00:00:00Z'}]
        : Array.from({length:20},(_,index)=>({name:`recent-${recentPage}-${index}.txt`,path:`recent-${recentPage}-${index}.txt`,type:'file',size:index+1,lastModified:new Date(Date.UTC(2026,7,31-recentPage,index)).toISOString()}));
      body.pagination={page:recentPage,limit:20,totalFiles:recentTotalPages*20,totalPages:recentTotalPages};
    } else if (url.pathname === '/api/directory/list') {
      const dir=url.searchParams.get('dir')||'';
      if(browseDirectories){
        body.files = dir==='项目资料/二级目录' ? [{ name:'nested.txt',path:'项目资料/二级目录/nested.txt',type:'file',size:8,lastModified:'2026-08-30T00:00:00Z' }] : [];
        body.directories = dir==='' ? [{ name:'项目资料',path:'项目资料',type:'directory' }]
          : dir==='项目资料' ? [{ name:'二级目录',path:'项目资料/二级目录',type:'directory' }] : [];
      }else{
        body.files = [{ name: 'alpha.txt', path: 'alpha.txt', type: 'file', size: 12, lastModified:'2026-08-30T00:00:00Z' }];
        body.directories = [];
      }
      body.nextCursor = null;
    } else if (url.pathname === '/api/directory/tree') {
      body.directories = [{ name:'docs',path:'docs',type:'directory' },{ name:'guides',path:'docs/guides',type:'directory' }];
      body.totalDirectories = body.directories.length;
    } else if (url.pathname === '/api/meta/alpha.txt') {
      body.metadata = { path:'alpha.txt', exists:true, contentType:'text/plain', contentLength:12, lastModified:'2024-01-02T03:04:05Z', etag:'test-etag' };
    } else if (url.pathname === '/api/trash/list') {
      const trashPage=Number(url.searchParams.get('page')||1);
      body.entries = trashEntries.slice((trashPage-1)*20,trashPage*20);
      body.pagination = { page:trashPage,limit:20,totalEntries:trashEntries.length,totalPages:Math.max(1,Math.ceil(trashEntries.length/20)) };
    } else if (url.pathname === '/api/shares' && method === 'POST') {
      const input=route.request().postDataJSON();
      const share={ id:shareId,path:input.path,name:'alpha.txt',type:input.type,createdAt:'2026-08-30T00:00:00Z',expiresAt:'2026-09-06T00:00:00Z',passwordProtected:Boolean(input.password),expired:false,url:`${url.origin}/s/${shareId}` };
      shares=[share]; body.share=share;
    } else if (url.pathname === '/api/shares' && method === 'GET') {
      body.shares=shares;
    } else if (url.pathname === `/api/shares/${shareId}` && method === 'DELETE') {
      shares=[];
    } else if (url.pathname === `/api/public/shares/${shareId}/access`) {
      publicUnlocked=true; body.unlocked=true;
    } else if (url.pathname === `/api/public/shares/${shareId}`) {
      body.share=publicUnlocked
        ? { id:shareId,name:'alpha.txt',type:'file',locked:false,size:12,expiresAt:'2026-09-06T00:00:00Z',passwordProtected:true,files:[] }
        : { id:shareId,name:'alpha.txt',type:'file',locked:true,expiresAt:'2026-09-06T00:00:00Z',passwordProtected:true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('authenticated user can browse files and open trash', async ({ page }) => {
  await mockApi(page, true);
  const directoryRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/directory/list');
  await page.goto('/');
  expect(new URL((await directoryRequest).url()).searchParams.get('expand')).toBe('true');
  await expect(page.locator('#files-body')).toContainText('alpha.txt');
  await expect(page.locator('#files-body .file-actions .text-action')).toHaveCount(6);
  await expect(page.locator('#files-body .file-actions')).toContainText('分享');
  await expect(page.locator('#files-body .file-actions')).toContainText('下载');
  await expect(page.locator('#files-body .file-date')).not.toHaveText('-');
  const batchButton = page.locator('#batch-delete-btn');
  await expect(batchButton).toBeDisabled();
  await expect(page.locator('[data-action="refresh"] + #batch-delete-btn')).toHaveCount(1);
  await page.locator('[data-action="select-file"]').check();
  await expect(batchButton).toBeEnabled();
  await expect(batchButton).toContainText('(1)');
  await page.locator('[data-page="trash"]').click();
  await expect(page.locator('#trash-body')).toContainText('回收站为空');
});

test('each navigation feature has a stable URL and supports browser history', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/files');
  const routes = {
    files: '/files', recent: '/recent', shares: '/shares', trash: '/trash',
    dashboard: '/dashboard', settings: '/settings',
  };
  for (const [name, pathname] of Object.entries(routes)) {
    const item = page.locator(`[data-page="${name}"]`);
    await expect(item).toHaveAttribute('href', pathname);
    await item.click();
    await expect(page).toHaveURL(url => url.pathname === pathname);
  }
  await page.locator('.sidebar-upload').click();
  await expect(page).toHaveURL(url => url.pathname === '/upload');
  await page.goBack();
  await expect(page).toHaveURL(url => url.pathname === '/settings');
  await expect(page.locator('#p-settings')).toHaveClass(/active/);
  await expect(page.locator('#nav-sidebar')).toBeVisible();
  await expect(page.locator('#settings-body .settings-storage')).toBeHidden();
  await expect(page.locator('#settings-body .settings-group.mobile-settings-nav')).toBeHidden();
});

test('direct feature URLs restore their page without first loading the file view', async ({ page }) => {
  let directoryRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/directory/list') directoryRequests++;
  });
  await mockApi(page, true);
  await page.goto('/trash');
  await expect(page).toHaveURL(url => url.pathname === '/trash');
  await expect(page.locator('#p-trash')).toHaveClass(/active/);
  await expect(page.locator('#trash-body')).toContainText('回收站为空');
  expect(directoryRequests).toBe(0);
});

test('initial file list is requested before directory-tree prefetch', async ({ page }) => {
  const order=[];
  page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(path==='/api/directory/list'||path==='/api/directory/tree') order.push(path);
  });
  await mockApi(page,true);
  await page.goto('/');
  await expect.poll(()=>order.includes('/api/directory/tree')).toBe(true);
  expect(order.indexOf('/api/directory/list')).toBeLessThan(order.indexOf('/api/directory/tree'));
});

test('searching from another page sends only the recursive search directory request', async ({ page }) => {
  const directoryRequests=[];
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/directory/list') directoryRequests.push(url);
  });
  await mockApi(page,true);
  await page.goto('/');
  await page.locator('[data-page="recent"]').click();
  const baseline=directoryRequests.length;
  await page.locator('#global-search').fill('alpha');
  await expect.poll(()=>directoryRequests.length).toBe(baseline+1);
  const request=directoryRequests.at(-1);
  expect(request.searchParams.get('search')).toBe('alpha');
  expect(request.searchParams.get('recursive')).toBe('true');
});

test('newer searches replace slower in-flight search results', async ({ page }) => {
  await mockApi(page,true);
  await page.route('**/api/directory/list*',async route=>{
    const url=new URL(route.request().url());
    const search=url.searchParams.get('search');
    if(!search) return route.fallback();
    if(search==='first') await new Promise(resolve=>setTimeout(resolve,900));
    const file={name:`${search}.txt`,path:`${search}.txt`,type:'file',size:1,lastModified:'2026-09-01T00:00:00Z'};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,files:[file],directories:[],pagination:{page:1,totalPages:1}})});
  });
  await page.goto('/');
  await page.locator('#global-search').fill('first');
  await page.waitForRequest(request=>new URL(request.url()).searchParams.get('search')==='first');
  await page.locator('#global-search').fill('second');
  await page.waitForRequest(request=>new URL(request.url()).searchParams.get('search')==='second');
  await expect(page.locator('#files-body')).toContainText('second.txt');
  await page.waitForTimeout(950);
  await expect(page.locator('#files-body')).toContainText('second.txt');
  await expect(page.locator('#files-body')).not.toContainText('first.txt');
});

test('trash loads 20 entries per page and requests the next page', async ({ page }) => {
  const entries=Array.from({length:25},(_,index)=>({batchId:`batch-${String(index).padStart(20,'0')}`,originalPath:`deleted-${index}.txt`,deletedAt:new Date(Date.UTC(2026,7,index+1)).toISOString()}));
  await mockApi(page,true,entries);
  await page.goto('/');
  await page.locator('[data-page="trash"]').click();
  await expect(page.locator('#trash-body tbody tr')).toHaveCount(20);
  const nextRequest=page.waitForRequest(request=>{
    const url=new URL(request.url());
    return url.pathname==='/api/trash/list'&&url.searchParams.get('page')==='2';
  });
  await page.locator('[data-action="trash-next"]').click();
  await nextRequest;
  await expect(page.locator('#trash-body tbody tr')).toHaveCount(5);
  await expect(page.locator('#trash-body .recent-pagination')).toContainText('第 2 / 2 页');
});

test('repository status and dashboard reuse one repository-info request', async ({ page }) => {
  let repoRequests=0;
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/repo/info'){
      repoRequests++;
      expect(url.searchParams.get('summary')).toBe('true');
    }
  });
  await mockApi(page,true);
  await page.goto('/');
  await expect.poll(()=>repoRequests).toBe(1);
  await page.locator('[data-page="dashboard"]').click();
  await expect(page.locator('#dashboard-body')).toContainText('owner/repo');
  await page.locator('[data-page="settings"]').click();
  await page.locator('[data-action="test-connection"]').click();
  await expect(page.locator('#toast-container .toast.success')).toBeVisible();
  expect(repoRequests).toBe(1);
});

test('sidebar storage percentage follows public and private repository quotas', async ({ page }) => {
  await mockApi(page, true);
  let repository = { id:'owner/repo',private:true,size:{nbFiles:1,sizeInBytes:25 * 1024 ** 3},downloads:0,likes:0 };
  await page.route('**/api/repo/info*', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify({ success:true,info:repository }),
  }));

  await page.goto('/');
  await expect(page.locator('#storage-percent')).toHaveText('25.00%');
  await expect(page.locator('#storage-usage')).toHaveText('25.0 GB / 100.0 GB');
  await expect(page.locator('#storage-plan')).toHaveText('私有仓库');
  await expect(page.locator('#storage-track')).toHaveAttribute('aria-valuenow','25.00');

  repository = { ...repository,private:false,size:{nbFiles:1,sizeInBytes:2 * 1024 ** 4} };
  await page.reload();
  await expect(page.locator('#storage-percent')).toHaveText('25.00%');
  await expect(page.locator('#storage-usage')).toHaveText('2.0 TB / 8.0 TB');
  await expect(page.locator('#storage-plan')).toHaveText('公开仓库');
  await expect(page.locator('#storage-track')).toHaveAttribute('aria-valuenow','25.00');
});

test('mobile settings shows repository storage below the profile card', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await mockApi(page, true);
  await page.route('**/api/repo/info*', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify({
      success:true,
      info:{ id:'owner/repo',private:true,size:{nbFiles:1,sizeInBytes:25 * 1024 ** 3} },
    }),
  }));

  await page.goto('/settings');
  const storage = page.locator('#settings-body .settings-storage');
  await expect(storage).toBeVisible();
  await expect(storage.locator('#mobile-storage-percent')).toHaveText('25.00%');
  await expect(storage.locator('#mobile-storage-usage')).toHaveText('25.0 GB / 100.0 GB');
  await expect(storage.locator('#mobile-storage-plan')).toHaveText('私有仓库');
  await expect(storage.locator('#mobile-storage-track')).toHaveAttribute('aria-valuenow','25.00');
  const profileBottom = await page.locator('#settings-body .settings-profile').evaluate(element => element.getBoundingClientRect().bottom);
  const storageTop = await storage.evaluate(element => element.getBoundingClientRect().top);
  expect(storageTop).toBeGreaterThanOrEqual(profileBottom);
});

test('file details render known list metadata before the metadata request completes', async ({ page }) => {
  let releaseMetadata;
  const metadataGate=new Promise(resolve=>{releaseMetadata=resolve;});
  await mockApi(page,true);
  await page.route('**/api/meta/alpha.txt',async route=>{
    await metadataGate;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,metadata:{contentLength:12,contentType:'text/plain',lastModified:'2024-01-02T03:04:05Z',etag:'etag'}})});
  });
  await page.goto('/');
  await page.locator('[data-action="detail-alpha.txt"]').click();
  await expect(page.locator('#detail-panel-body')).toContainText('12 B',{timeout:300});
  await expect(page.locator('#detail-panel-body')).toContainText('alpha.txt',{timeout:300});
  releaseMetadata();
  await expect(page.locator('#detail-panel-body')).toContainText('text/plain');
});

test('page navigation cancels stale loads and reuses completed short-term cache', async ({ page }) => {
  let releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  let recentRequests=0;
  await mockApi(page,true);
  await page.route('**/api/directory/recent*',async route=>{
    recentRequests++;
    if(recentRequests===1)await firstGate;
    try{
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,files:[{name:'cached.txt',path:'cached.txt',type:'file',size:1,lastModified:'2026-09-01T00:00:00Z'}],pagination:{page:1,limit:20,totalFiles:1,totalPages:1}})});
    }catch{/* The first request is intentionally cancelled by navigation. */}
  });
  await page.goto('/');
  await page.locator('[data-page="recent"]').click();
  await expect.poll(()=>recentRequests).toBe(1);
  await page.locator('[data-page="shares"]').click();
  releaseFirst();
  await page.locator('[data-page="recent"]').click();
  await expect(page.locator('#recent-body')).toContainText('cached.txt');
  expect(recentRequests).toBe(2);
  await page.locator('[data-page="shares"]').click();
  await page.locator('[data-page="recent"]').click();
  await expect(page.locator('#recent-body')).toContainText('cached.txt');
  expect(recentRequests).toBe(2);
});

test('file mutation invalidates the cached directory view', async ({ page }) => {
  let directoryRequests=0;
  page.on('request',request=>{
    if(new URL(request.url()).pathname==='/api/directory/list')directoryRequests++;
  });
  await mockApi(page,true);
  await page.goto('/');
  await page.locator('[data-page="recent"]').click();
  await page.locator('[data-page="files"]').click();
  expect(directoryRequests).toBe(1);
  await page.locator('[data-action="del-alpha.txt"]').click();
  await page.locator('#modal-footer .btn-danger').click();
  await expect.poll(()=>directoryRequests).toBe(2);
});

test('file selection updates one item and load-more appends without replacing existing rows',async({page})=>{
  await mockApi(page,true);
  await page.route('**/api/directory/list*',async route=>{
    const cursor=new URL(route.request().url()).searchParams.get('cursor');
    const body=cursor==='next'
      ? {success:true,files:[{name:'beta.txt',path:'beta.txt',type:'file',size:7}],directories:[],pagination:{nextCursor:null}}
      : {success:true,files:[{name:'alpha.txt',path:'alpha.txt',type:'file',size:12}],directories:[],pagination:{nextCursor:'next'}};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/');
  await expect(page.locator('#files-body tbody tr')).toHaveCount(1);
  await page.evaluate(()=>{document.querySelector('#files-body tbody tr').dataset.testIdentity='original';});
  await page.locator('#files-body [data-action="select-file"]').click();
  await expect(page.locator('#files-body tbody tr[data-test-identity="original"]')).toHaveCount(1);
  await expect(page.locator('#files-body tbody tr[data-test-identity="original"]')).toHaveClass(/selected/);
  await expect(page.locator('#batch-delete-btn')).toBeEnabled();
  await page.locator('[data-action="load-more"]').click();
  await expect(page.locator('#files-body tbody tr')).toHaveCount(2);
  await expect(page.locator('#files-body tbody tr[data-test-identity="original"]')).toHaveCount(1);
  await expect(page.locator('#files-body tbody tr').nth(1)).toContainText('beta.txt');
});

test('leaving the files page aborts an in-flight load-more request',async({page})=>{
  await page.addInitScript(()=>{
    window.__abortedDirectoryCursors=[];
    const originalFetch=window.fetch.bind(window);
    window.fetch=(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url,window.location.origin);
      const cursor=url.searchParams.get('cursor');
      if(cursor&&init.signal)init.signal.addEventListener('abort',()=>window.__abortedDirectoryCursors.push(cursor),{once:true});
      return originalFetch(input,init);
    };
  });
  let releaseMore;
  const moreGate=new Promise(resolve=>{releaseMore=resolve;});
  await mockApi(page,true);
  await page.route('**/api/directory/list*',async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get('cursor')==='next'){
      await moreGate;
      try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,files:[{name:'later.txt',path:'later.txt',type:'file',size:1}],directories:[],pagination:{nextCursor:null}})});}catch{/* Request was cancelled. */}
      return;
    }
    if(!url.searchParams.get('search')){
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,files:[{name:'alpha.txt',path:'alpha.txt',type:'file',size:12}],directories:[],pagination:{nextCursor:'next'}})});
      return;
    }
    await route.fallback();
  });
  await page.goto('/');
  const moreRequest=page.waitForRequest(request=>new URL(request.url()).searchParams.get('cursor')==='next');
  await page.locator('[data-action="load-more"]').click();
  await moreRequest;
  await page.locator('[data-page="recent"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__abortedDirectoryCursors)).toContain('next');
  releaseMore();
});

test('upload navigation carries the current nested directory into the destination field', async ({ page }) => {
  await mockApi(page,true,[],true);
  await page.goto('/');
  await page.locator('[data-action="cd-项目资料"]').click();
  await page.locator('[data-action="cd-项目资料/二级目录"]').click();
  await expect(page.locator('#breadcrumb')).toContainText('二级目录');
  await expect(page).toHaveURL(url => url.pathname === '/files' && url.searchParams.get('dir') === '项目资料/二级目录');
  await page.locator('.sidebar-upload').click();
  await expect(page).toHaveURL(url => url.pathname === '/upload');
  await expect(page.locator('#p-upload')).toHaveClass(/active/);
  await expect(page.locator('#upload-dir-input')).toHaveValue('项目资料/二级目录');
});

test('upload composer stays compact on desktop and mobile', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/upload');
  const uploadZone = page.locator('#upload-zone');
  const uploadCard = page.locator('#p-upload .upload-card');
  expect(Math.round((await uploadZone.boundingBox()).height)).toBeLessThanOrEqual(180);
  expect(Math.round((await uploadCard.boundingBox()).height)).toBeLessThanOrEqual(340);

  await page.setViewportSize({ width:390, height:844 });
  expect(Math.round((await uploadZone.boundingBox()).height)).toBeLessThanOrEqual(152);
  expect(Math.round((await uploadCard.boundingBox()).height)).toBeLessThanOrEqual(320);
  await expect(page.locator('#p-upload .upload-capabilities')).toBeHidden();

  await page.locator('#file-input').setInputFiles({
    name:'compact-upload.txt',
    mimeType:'text/plain',
    buffer:Buffer.from('compact'),
  });
  const transfer = page.locator('#upload-progress-area');
  await expect(transfer).toBeVisible();
  expect((await transfer.boundingBox()).y).toBeLessThan(700);
});

test('upload picker renders a detailed transfer list and supports removing completed files', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/upload');
  await page.locator('#file-input').setInputFiles({
    name: 'holiday-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('preview-image'),
  });
  const transfer = page.locator('#upload-progress-area');
  await expect(transfer).toBeVisible();
  await expect(transfer).toContainText('holiday-photo.jpg');
  await expect(transfer).toContainText('已完成');
  await expect(page.locator('#upload-queue-count')).toContainText('1 个项目');
  await expect(page.locator('#upload-overall-percent')).toHaveText('100%');
  await page.locator('[data-action^="remove-upload-"]').click();
  await expect(transfer).toBeHidden();
});

test('directory picker preloads and reuses its compact directory tree', async ({ page }) => {
  let treeRequests=0;
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/directory/tree'){
      treeRequests++;
      expect(url.searchParams.get('directoriesOnly')).toBe('true');
    }
  });
  await mockApi(page,true);
  await page.goto('/');
  await expect.poll(()=>treeRequests).toBe(1);
  await page.locator('.sidebar-upload').click();
  await page.locator('[data-action="pick-upload-dir"]').click();
  await expect(page.locator('#modal-title')).toHaveText('选择目录');
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="pick-upload-dir"]').click();
  await expect(page.locator('#modal-title')).toHaveText('选择目录');
  expect(treeRequests).toBe(1);
});

test('move picker opens from the prefetched directory tree without another request', async ({ page }) => {
  let treeRequests=0;
  page.on('request',request=>{
    if(new URL(request.url()).pathname==='/api/directory/tree') treeRequests++;
  });
  await mockApi(page,true);
  await page.goto('/');
  await expect.poll(()=>treeRequests).toBe(1);
  await page.locator('[data-action="mv-alpha.txt"]').click();
  await page.locator('[data-action="pick-move-dir"]').click();
  await expect(page.locator('#modal-title')).toHaveText('选择目录');
  await expect(page.locator('.dir-picker-item')).toHaveCount(1);
  await page.locator('.dir-picker-item[data-dir="docs"]').dblclick();
  await expect(page.locator('.dir-picker-item')).toHaveCount(2);
  expect(treeRequests).toBe(1);
});

test('login overlay submits the deployment password without exposing a token field', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/');
  await expect(page.locator('#login-overlay')).toBeVisible();
  await expect(page.locator('input[name*="token" i]')).toHaveCount(0);
  await page.locator('#login-password').fill('test-only-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#login-overlay')).toBeHidden();
  await expect(page.locator('#files-body')).toContainText('alpha.txt');
});

test('recent uploads shows file metadata without an actions column', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/');
  await page.locator('[data-page="recent"]').click();
  const recent = page.locator('#recent-body');
  await expect(recent).toContainText('alpha.txt');
  await expect(recent.locator('.file-date')).not.toHaveText('-');
  await expect(recent.locator('th')).toHaveCount(3);
  await expect(recent.locator('.file-actions, [data-action^="detail-"]')).toHaveCount(0);
  await expect(recent.locator('.recent-pagination')).toContainText('第 1 / 1 页');
});

test('recent uploads loads only 20 files per page and navigates server pages',async({page})=>{
  await mockApi(page,true,[],false,3);
  await page.goto('/');
  const secondPageRequest=page.waitForRequest(request=>{
    const url=new URL(request.url());
    return url.pathname==='/api/directory/recent'&&url.searchParams.get('page')==='2';
  });
  await page.locator('[data-page="recent"]').click();
  await expect(page.locator('#recent-body tbody tr')).toHaveCount(20);
  await expect(page.locator('#recent-body')).toContainText('recent-1-0.txt');
  await page.locator('[data-action="recent-next"]').click();
  await secondPageRequest;
  await expect(page.locator('#recent-body tbody tr')).toHaveCount(20);
  await expect(page.locator('#recent-body')).toContainText('recent-2-0.txt');
  await expect(page.locator('.recent-pagination')).toContainText('第 2 / 3 页');
});

test('file details show the repository modification time from the file list', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/');
  await page.locator('#files-body [data-action="detail-alpha.txt"]').click();
  await expect(page.locator('#detail-panel-body')).toContainText('2024');
  await expect(page.locator('#detail-panel-body')).not.toContainText('修改时间-');
  await expect(page.locator('#detail-panel-body [data-action^="dl-"]')).toHaveText('下载');
  await expect(page.locator('#detail-panel-body [data-action^="rn-"]')).toHaveText('重命名');
  await page.locator('[data-action="close-detail"]').click();

});

test('managed shares render fixed pages of 20',async({page})=>{
  const shares=Array.from({length:25},(_,index)=>({
    id:index.toString(36).padStart(8,'0'),path:`shared-${index}.txt`,name:`shared-${index}.txt`,type:'file',
    createdAt:new Date(Date.UTC(2026,0,25-index)).toISOString(),expiresAt:null,passwordProtected:false,expired:false,
  }));
  await mockApi(page,true);
  await page.route('**/api/shares*',async route=>{
    if(route.request().method()!=='GET'){await route.fallback();return;}
    const url=new URL(route.request().url());
    const currentPage=Number(url.searchParams.get('page')||1);
    const start=(currentPage-1)*20;
    const pageShares=shares.slice(start,start+20).map(share=>({...share,url:`${url.origin}/s/${share.id}`}));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      success:true,shares:pageShares,pagination:{page:currentPage,limit:20,totalShares:shares.length,totalPages:2},
    })});
  });
  await page.goto('/');
  await page.locator('[data-page="shares"]').click();
  await expect(page.locator('#shares-body .share-card')).toHaveCount(20);
  const nextRequest=page.waitForRequest(request=>{
    const url=new URL(request.url());
    return url.pathname==='/api/shares'&&url.searchParams.get('page')==='2';
  });
  await page.locator('[data-action="shares-next"]').click();
  await nextRequest;
  await expect(page.locator('#shares-body .share-card')).toHaveCount(5);
  await expect(page.locator('#shares-body .recent-pagination')).toContainText('2 / 2');
});

test('owner can create, manage and revoke a password-protected share', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/');
  await page.locator('#files-body [data-action="share-file-alpha.txt"]').click();
  await page.locator('#share-expiry').selectOption('604800');
  await page.locator('#share-password').fill('visitor-password');
  await page.locator('#confirm-create-share').click();
  await expect(page.locator('#modal-title')).toHaveText('分享创建成功');
  await expect(page.locator('#created-share-url')).toHaveValue(/^http:\/\/127\.0\.0\.1:8788\/s\/[A-Za-z0-9]{8}$/);
  await page.locator('#modal-footer button').click();
  await page.locator('[data-page="shares"]').click();
  await expect(page.locator('#shares-body .share-card')).toContainText('alpha.txt');
  await expect(page.locator('#shares-body .share-card')).toContainText('密码保护');
  await expect(page.locator('#shares-body .share-copy-button')).toBeVisible();
  await expect(page.locator('#shares-body .share-revoke-button')).toHaveText('取消分享');
  await page.locator('[data-action^="revoke-share-"]').click();
  await expect(page.locator('#modal-title')).toHaveText('撤销分享');
  await page.locator('#modal-footer .btn-danger').click();
  await expect(page.locator('#shares-body')).toContainText('暂无分享');
});

test('visitor unlocks a protected public share and sees the download action', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/s/aB3dE5g7');
  await expect(page.locator('.share-public-brand')).toContainText('HF Drive');
  await expect(page.locator('.share-header-badge')).toContainText('安全分享');
  await expect(page.locator('#share-content')).toContainText('此分享受密码保护');
  await page.locator('#share-access-password').fill('visitor-password');
  await page.locator('#share-unlock-form button').click();
  await expect(page.locator('#share-content')).toContainText('alpha.txt');
  await expect(page.locator('#share-content .share-owner')).toContainText('HF Drive');
  await expect(page.locator('#share-content .share-download-button')).toBeVisible();
  await expect(page.locator('#share-content a[href$="/download"]')).toBeVisible();
});

test('visitor browses nested shared folders by double-clicking directories', async ({ page }) => {
  const shareId='cD4eF6g8';
  await page.route(`**/api/public/shares/${shareId}`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,share:{
    id:shareId,name:'项目资料',type:'directory',locked:false,expiresAt:null,passwordProtected:false,
    files:[
      {path:'根目录.txt',name:'根目录.txt',size:2,lastModified:'2026-08-30T00:00:00Z'},
      {path:'一级/二级/报告.pdf',name:'报告.pdf',size:20,lastModified:'2026-08-30T00:00:00Z'},
    ],directories:['一级','一级/二级'],truncated:false,
  }})}));
  await page.goto(`/s/${shareId}`);
  await expect(page.locator('.share-public-directory')).toHaveText(/一级/);
  await expect(page.locator('.share-public-files')).toContainText('根目录.txt');
  await expect(page.locator('.share-public-files')).not.toContainText('报告.pdf');

  await page.locator('.share-public-directory').dblclick();
  await expect(page.locator('.share-breadcrumb')).toContainText('一级');
  await expect(page.locator('.share-public-directory')).toHaveText(/二级/);
  await page.locator('.share-public-directory').dblclick();
  await expect(page.locator('.share-breadcrumb')).toContainText('二级');
  await expect(page.locator('.share-public-files')).toContainText('报告.pdf');
  await expect(page.locator('.share-public-files .share-row-download')).toHaveText('下载');
  const downloadUrl=new URL(await page.locator('.share-public-file a').getAttribute('href'),'https://disk.test');
  expect(downloadUrl.searchParams.get('file')).toBe('一级/二级/报告.pdf');

  await page.locator('.share-breadcrumb-item').first().click();
  await expect(page.locator('.share-public-files')).toContainText('根目录.txt');
});

test('mobile file lists become complete cards without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await mockApi(page, true);
  await page.goto('/');
  const mobileUpload = page.locator('#p-files .page-toolbar .mobile-upload');
  await expect(mobileUpload).toBeVisible();
  expect(await mobileUpload.evaluate(button => button.nextElementSibling?.dataset.action)).toBe('refresh');
  const toolbarButtonSizes = await page.locator('#p-files .page-toolbar [data-action="nav-upload"], #p-files .page-toolbar [data-action="refresh"]').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { width:Math.round(box.width), height:Math.round(box.height) };
  }));
  expect(toolbarButtonSizes[0]).toEqual(toolbarButtonSizes[1]);
  const toolbarAlignment = await page.locator('#p-files .page-toolbar').evaluate(toolbar => {
    const breadcrumb = toolbar.querySelector('.breadcrumb').getBoundingClientRect();
    const upload = toolbar.querySelector('.mobile-upload').getBoundingClientRect();
    return {
      breadcrumbCenter:Math.round(breadcrumb.top + breadcrumb.height / 2),
      uploadCenter:Math.round(upload.top + upload.height / 2),
    };
  });
  expect(toolbarAlignment.breadcrumbCenter).toBe(toolbarAlignment.uploadCenter);
  const files = page.locator('#files-body');
  await expect(files.locator('.file-type')).toBeHidden();
  await expect(files.locator('.file-size > .file-type')).toHaveCount(1);
  await expect(files.locator('.file-name .file-type')).toHaveCount(0);
  await expect(files.locator('.file-size')).toBeVisible();
  await expect(files.locator('.file-date')).toBeVisible();
  await expect(files.locator('.file-actions')).toBeVisible();
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height:844 });
    const nameCellWidth = await files.locator('.file-table tbody > tr td:nth-child(2)').first().evaluate(cell => Math.round(cell.getBoundingClientRect().width));
    expect(nameCellWidth).toBeGreaterThanOrEqual(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width:390, height:844 });
  const fileCardHeights = await files.locator('.file-table tbody > tr').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
  expect(Math.max(...fileCardHeights)).toBeLessThanOrEqual(82);
  const actionBoxes = await files.locator('.file-actions .btn').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { width:Math.round(box.width), top:Math.round(box.top) };
  }));
  expect(new Set(actionBoxes.map(box => box.width))).toEqual(new Set([38]));
  expect(new Set(actionBoxes.map(box => box.top)).size).toBe(1);
  const fileActionAlignment = await files.locator('.file-actions').evaluate(actions => {
    const container = actions.getBoundingClientRect();
    const last = actions.lastElementChild.getBoundingClientRect();
    return Math.round(container.right - last.right);
  });
  expect(fileActionAlignment).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mobileShell = await page.evaluate(() => {
    const app = document.querySelector('#app').getBoundingClientRect();
    const tabs = document.querySelector('.mobile-tabbar').getBoundingClientRect();
    return {
      tabPosition: window.getComputedStyle(document.querySelector('.mobile-tabbar')).position,
      appBottom: Math.round(app.bottom),
      tabsBottom: Math.round(tabs.bottom),
      viewportBottom: Math.round(window.innerHeight),
    };
  });
  expect(mobileShell.tabPosition).toBe('relative');
  expect(mobileShell.tabsBottom).toBe(mobileShell.appBottom);
  expect(mobileShell.appBottom).toBe(mobileShell.viewportBottom);
  await expect(page.locator('#sidebar-toggle')).toBeHidden();
  await expect(page.locator('#nav-sidebar')).toBeHidden();
  await expect(page.locator('.mobile-tabbar [data-action="nav-trash"]')).toHaveCount(0);
  const mobileSettings = page.locator('.mobile-tabbar [data-action="nav-settings"]');
  await expect(mobileSettings).toBeVisible();
  await mobileSettings.click();
  const mobileSettingsGroup = page.locator('#settings-body .settings-group.mobile-settings-nav');
  await expect(mobileSettingsGroup).toBeVisible();
  await mobileSettingsGroup.locator('[data-action="nav-dashboard"]').click();
  await expect(page).toHaveURL(url => url.pathname === '/dashboard');
  await mobileSettings.click();
  await mobileSettingsGroup.locator('[data-action="nav-trash"]').click();
  await expect(page).toHaveURL(url => url.pathname === '/trash');
  await page.locator('.mobile-tabbar [data-action="nav-recent"]').click();
  const recent = page.locator('#recent-body');
  await expect(recent.locator('.file-size')).toBeVisible();
  await expect(recent.locator('.file-date')).toBeVisible();
  await expect(recent.locator('.file-actions')).toHaveCount(0);
  const recentCardHeights = await recent.locator('.file-table tbody > tr').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
  expect(Math.max(...recentCardHeights)).toBeLessThanOrEqual(68);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('trash toolbar uses the app modal to confirm emptying all entries', async ({ page }) => {
  await mockApi(page, true, [{ batchId:'a'.repeat(20), originalPath:'old.txt', deletedAt:'2026-08-30T00:00:00Z' }]);
  await page.goto('/');
  await page.locator('[data-page="trash"]').click();
  const button = page.locator('#empty-trash-btn');
  await expect(button).toBeEnabled();
  await expect(page.locator('#p-trash .toolbar-right #empty-trash-btn')).toHaveCount(1);
  await button.click();
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await expect(page.locator('#modal-title')).toHaveText('确认清空回收站');
  await expect(page.locator('#modal-body')).toContainText('无法撤销');
  await page.locator('#confirm-empty-trash-btn').click();
  await expect(page.locator('#modal-overlay')).toBeHidden();
  await expect(page.locator('#toast-container')).toContainText('回收站已清空');
});
