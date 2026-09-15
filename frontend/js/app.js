/**
 * HF Netdisk — 主应用逻辑
 * 百度网盘风格交互，完整覆盖全部 API
 */
import { API } from './api.js';
import { AuthUI } from './login.js';
import { state as S } from './state/store.js';
import { createTrashPage } from './pages/trash.js';
import { escapeHtml, formatBytes } from './utils/format.js';
import { createFrameScheduler } from './utils/frameScheduler.js';

(() => {
  'use strict';

  // ============================================================
  //  全局状态
  // ============================================================
  const qs = (s, p) => (p || document).querySelector(s);
  const qsa = (s, p) => (p || document).querySelectorAll(s);

  // ============================================================
  //  工具
  // ============================================================
  const U = {
    size: formatBytes,
    date(d) {
      if (!d) return '-';
      const t = new Date(d), n = new Date(), diff = n - t;
      if (diff < 6e4) return '刚刚';
      if (diff < 36e5) return Math.floor(diff / 6e4) + ' 分钟前';
      if (diff < 864e5) return Math.floor(diff / 36e5) + ' 小时前';
      if (diff < 6048e5) return Math.floor(diff / 864e5) + ' 天前';
      return t.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    icon(name, type) {
      if (type === 'directory' || type === 'folder') return '📁';
      const ext = (name || '').split('.').pop().toLowerCase();
      const m = {
        jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
        mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬',
        mp3: '🎵', wav: '🎵', flac: '🎵',
        pdf: '📄', doc: '📝', docx: '📝',
        zip: '📦', tar: '📦', gz: '📦', rar: '📦', '7z': '📦',
        js: '📜', ts: '📜', py: '📜', html: '📜', css: '📜', json: '📜',
        txt: '📃', md: '📃',
      };
      return m[ext] || '📄';
    },
    esc: escapeHtml,
    isDir(f) { return f.type === 'directory' || f.type === 'folder'; },
    fName(f) { return f.name || f.path || f.key || ''; },
    fPath(f) { return f.path || f.name || f.key || ''; },
    sortDirFirst(arr) {
      return [...arr].sort((a, b) => {
        const aD = U.isDir(a), bD = U.isDir(b);
        if (aD && !bD) return -1; if (!aD && bD) return 1;
        return (U.fName(a)).localeCompare(U.fName(b));
      });
    },
  };

  // ============================================================
  //  Toast
  // ============================================================
  const Toast = {
    container: null,
    init() { this.container = qs('#toast-container'); },
    _make(title, msg, type, dur) {
      const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
      const el = document.createElement('div');
      el.className = `toast ${type}`;
      el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><div class="toast-content"><div class="toast-title">${U.esc(title)}</div>${msg ? `<div class="toast-message">${U.esc(msg)}</div>` : ''}</div><button class="toast-close" data-action="close-toast">✕</button>`;
      this.container.appendChild(el);
      if (dur > 0) setTimeout(() => { if (el.parentNode) { el.classList.add('removing'); setTimeout(() => el.remove(), 250); } }, dur);
    },
    success(t, m) { this._make(t, m, 'success', 3500); },
    error(t, m) { this._make(t, m, 'error', 6000); },
    warning(t, m) { this._make(t, m, 'warning', 4500); },
    info(t, m) { this._make(t, m, 'info', 3500); },
  };
  const VIEW_CACHE_TTL = 15 * 1000;
  const viewCache = new Map();

  function getCachedView(key) {
    const cached = viewCache.get(key);
    if (!cached || Date.now() - cached.createdAt >= VIEW_CACHE_TTL) {
      viewCache.delete(key);
      return null;
    }
    return cached.value;
  }

  function setCachedView(key, value) {
    viewCache.set(key, { createdAt: Date.now(), value });
  }

  function invalidateCachedViews(...prefixes) {
    for (const key of viewCache.keys()) {
      if (prefixes.some(prefix => key.startsWith(prefix))) viewCache.delete(key);
    }
  }

  const TrashPage = createTrashPage({ toast: Toast, cacheTtl: VIEW_CACHE_TTL, onMutation: handleTrashMutation });
  const REPO_INFO_CACHE_TTL = 30 * 1000;
  let repoInfoCache = null;
  let repoInfoCacheTime = 0;
  let repoInfoRequest = null;

  function getRepoInfo({ force = false } = {}) {
    if (!force && repoInfoCache && Date.now() - repoInfoCacheTime < REPO_INFO_CACHE_TTL) {
      updateStorageUsage(repoInfoCache);
      return Promise.resolve(repoInfoCache);
    }
    if (!force && repoInfoRequest) return repoInfoRequest;
    const request = API.getRepoInfo().then(result => {
      repoInfoCache = result;
      repoInfoCacheTime = Date.now();
      updateStorageUsage(result);
      return result;
    }).finally(() => {
      if (repoInfoRequest === request) repoInfoRequest = null;
    });
    repoInfoRequest = request;
    return request;
  }

  // ============================================================
  //  Modal
  // ============================================================
  function showModal(title, bodyHtml, buttons) {
    qs('#modal-title').textContent = title;
    qs('#modal-body').innerHTML = bodyHtml;
    const footer = qs('#modal-footer');
    footer.innerHTML = '';
    if (buttons) {
      buttons.forEach(b => {
        const btn = document.createElement('button');
        btn.className = `btn ${b.cls || 'btn-outline'}`;
        btn.textContent = b.text;
        btn.addEventListener('click', b.action);
        if (b.id) btn.id = b.id;
        footer.appendChild(btn);
      });
    }
    qs('#modal-overlay').style.display = 'flex';
  }

  function closeModal() {
    qs('#modal-overlay').style.display = 'none';
  }

  // ============================================================
  //  导航
  // ============================================================
  const PAGE_PATHS = Object.freeze({
    files: '/files',
    recent: '/recent',
    shares: '/shares',
    trash: '/trash',
    dashboard: '/dashboard',
    settings: '/settings',
    upload: '/upload',
  });

  function readRoute() {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
    const page = Object.entries(PAGE_PATHS).find(([, path]) => path === pathname)?.[0] || 'files';
    const directory = page === 'files' ? (new URLSearchParams(window.location.search).get('dir') || '') : S.dir;
    return { page, directory };
  }

  function routeUrl(page) {
    const pathname = PAGE_PATHS[page] || PAGE_PATHS.files;
    if (page !== 'files' || !S.dir) return pathname;
    const params = new URLSearchParams({ dir: S.dir });
    return `${pathname}?${params}`;
  }

  function updateRoute(page, historyMode) {
    if (historyMode === 'none') return;
    const url = routeUrl(page);
    const current = window.location.pathname + window.location.search;
    if (historyMode === 'replace') window.history.replaceState({ page }, '', url);
    else if (current !== url) window.history.pushState({ page }, '', url);
  }

  function nav(page, { load = true, history = 'push' } = {}) {
    if (!PAGE_PATHS[page]) page = 'files';
    S.page = page;
    updateRoute(page, history);
    if (page !== 'files') {
      fileListController?.abort();
      searchController?.abort();
    }
    if (page !== 'recent') recentController?.abort();
    if (page !== 'shares') sharesController?.abort();
    if (page !== 'trash') TrashPage.cancel();
    S.selectedPaths.clear();
    updateBatchDeleteButton();
    qsa('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    qsa('.page').forEach(el => el.classList.toggle('active', el.id === 'p-' + page));

    const loaders = {
      files: () => loadFiles(),
      recent: loadRecent,
      upload: () => {},
      trash: TrashPage.load,
      shares: loadShares,
      dashboard: loadDashboard,
      settings: loadSettings,
    };
    if (load && loaders[page]) loaders[page]();

    // 移动端关闭侧边栏
    qs('#nav-sidebar').classList.remove('open');
    qs('#sidebar-backdrop').classList.remove('show');
  }

  // ============================================================
  //  文件管理 — 核心
  // ============================================================
  let searchTimer = null;
  let fileListController = null;
  let searchController = null;
  let detailController = null;
  let recentController = null;
  let sharesController = null;

  async function loadFiles(dir, { force = false } = {}) {
    if (dir !== undefined) S.dir = dir;
    searchController?.abort();
    searchController = null;
    fileListController?.abort();
    const controller = new AbortController();
    fileListController = controller;
    const body = qs('#files-body');
    const cacheKey = `files:${S.dir}`;
    const cached = force ? null : getCachedView(cacheKey);
    if (cached) {
      S.files = cached.items;
      S.nextCursor = cached.nextCursor;
      renderBreadcrumb();
      renderFileList(cached.items);
      fileListController = null;
      return;
    }
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>加载中...</span></div>';

    try {
      const result = await API.listDirectory(S.dir, { recursive: false, expand: true, signal: controller.signal });
      const files = result.files || [];
      const dirs = result.directories || [];
      // 合并目录和文件
      const allItems = [...dirs, ...files];
      S.files = allItems;
      S.nextCursor = result.pagination?.nextCursor || null;
      setCachedView(cacheKey, { items: allItems, nextCursor: S.nextCursor });

      renderBreadcrumb();
      renderFileList(allItems);
    } catch (e) {
      if (e.name === 'AbortError') return;
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>加载失败</h3><p>${U.esc(e.message)}</p><button class="btn btn-primary" style="margin-top:12px;" data-action="refresh">重试</button></div>`;
    } finally {
      if (fileListController === controller) fileListController = null;
    }
  }

  function renderBreadcrumb() {
    const bc = qs('#breadcrumb');
    const parts = S.dir ? S.dir.split('/').filter(Boolean) : [];
    let html = '<a data-action="cd-">全部文件</a>';
    if (S.dir) {
      html += '<span class="sep">›</span>';
      html += `<a data-action="cd-up" style="font-size:12px;">⬆ 上级</a>`;
    }
    let acc = '';
    parts.forEach((p, i) => {
      acc += (acc ? '/' : '') + p;
      html += '<span class="sep">›</span>';
      html += i === parts.length - 1
        ? `<span class="current">${U.esc(p)}</span>`
        : `<a data-action="cd-${U.esc(acc)}">${U.esc(p)}</a>`;
    });
    bc.innerHTML = html;
  }

  function renderFileList(items) {
    const body = qs('#files-body');
    const sorted = U.sortDirFirst(items);

    if (sorted.length === 0) {
      body.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><h3>此目录为空</h3><p>上传文件或切换目录查看</p></div>';
      updateBatchDeleteButton();
      return;
    }

    if (S.viewMode === 'grid') {
      body.innerHTML = `<div class="file-grid">${sorted.map(f => renderGridItem(f)).join('')}</div>`;
    } else {
      body.innerHTML = `<table class="file-table"><thead><tr>
        <th class="select-column"><input type="checkbox" class="file-checkbox" data-action="select-all" aria-label="选择全部文件"></th>
        <th class="name-column">文件名</th><th class="size-column">大小</th>
        <th class="date-column">修改时间</th><th class="actions-column">操作</th>
      </tr></thead><tbody>${sorted.map(f => renderTableRow(f)).join('')}</tbody></table>`;
    }
    updateLoadMoreControl();
    updateSelectAllCheckbox();
    updateBatchDeleteButton();
  }

  function updateLoadMoreControl() {
    const body = qs('#files-body');
    body.querySelector('.file-load-more')?.remove();
    if (S.nextCursor) body.insertAdjacentHTML('beforeend','<div class="file-load-more" style="text-align:center;padding:16px;"><button class="btn btn-outline" data-action="load-more">加载更多</button></div>');
  }

  function updateSelectAllCheckbox() {
    const checkbox = qs('#files-body [data-action="select-all"]');
    if (!checkbox) return;
    const selectedCount = S.files.reduce((count, file) => count + (S.selectedPaths.has(U.fPath(file)) ? 1 : 0), 0);
    checkbox.checked = S.files.length > 0 && selectedCount === S.files.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < S.files.length;
  }

  function updateFileSelection(filePath) {
    const selected = S.selectedPaths.has(filePath);
    const item = Array.from(qsa('#files-body .file-table tbody > tr, #files-body .file-grid > .file-grid-item'))
      .find(element => element.dataset.path === filePath);
    if (item) {
      item.classList.toggle('selected', selected);
      const checkbox = item.querySelector('[data-action="select-file"]');
      if (checkbox) checkbox.checked = selected;
    }
  }

  function appendFileItems(items) {
    if (!items.length) {
      updateLoadMoreControl();
      return;
    }
    const sorted = U.sortDirFirst(items);
    if (S.viewMode === 'grid') {
      qs('#files-body .file-grid')?.insertAdjacentHTML('beforeend', sorted.map(file => renderGridItem(file)).join(''));
    } else {
      qs('#files-body .file-table tbody')?.insertAdjacentHTML('beforeend', sorted.map(file => renderTableRow(file)).join(''));
    }
    updateLoadMoreControl();
    updateSelectAllCheckbox();
  }

  function updateBatchDeleteButton() {
    const button = qs('#batch-delete-btn');
    if (!button) return;
    const count = S.selectedPaths.size;
    button.disabled = count === 0;
    button.textContent = count ? `批量删除 (${count})` : '批量删除';
  }

  async function loadMoreFiles() {
    if(!S.nextCursor)return;
    fileListController?.abort();
    const controller=new AbortController();
    fileListController=controller;
    const directory=S.dir;
    const cursor=S.nextCursor;
    S.nextCursor=null;
    try {
      const result=await API.listDirectory(directory,{recursive:false,cursor,expand:true,signal:controller.signal});
      if(controller.signal.aborted||S.page!=='files'||S.dir!==directory)return;
      const newItems=[...(result.directories||[]),...(result.files||[])];
      S.files.push(...newItems);
      S.nextCursor=result.pagination?.nextCursor||null;
      setCachedView(`files:${S.dir}`, { items: S.files, nextCursor: S.nextCursor });
      appendFileItems(newItems);
    } catch(error) {
      if(error.name!=='AbortError')throw error;
    } finally {
      if(fileListController===controller)fileListController=null;
    }
  }

  function renderFileIcon(name, isDirectory, extraClass = '') {
    if (isDirectory) return `<span class="ficon ficon-folder ${extraClass}" aria-hidden="true"></span>`;
    const extension = (name.split('.').pop() || '').toLowerCase();
    const kind = /^(jpg|jpeg|png|gif|webp|svg|bmp|avif)$/.test(extension) ? 'image'
      : /^(mp4|mkv|mov|avi|webm|m4v)$/.test(extension) ? 'video'
        : /^(mp3|wav|flac|aac|ogg|m4a)$/.test(extension) ? 'audio'
          : /^(pdf|doc|docx|txt|md|rtf|xls|xlsx|csv|ppt|pptx)$/.test(extension) ? 'document'
            : /^(zip|rar|7z|tar|gz|bz2)$/.test(extension) ? 'archive' : 'generic';
    const label = (extension || 'FILE').slice(0, 4).toUpperCase();
    return `<span class="ficon ficon-file ficon-${kind} ${extraClass}" aria-hidden="true"><span>${U.esc(label)}</span></span>`;
  }

  function actionIcon(name) {
    const paths = {
      share: '<path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M7 10H5.5A2.5 2.5 0 0 0 3 12.5v6A2.5 2.5 0 0 0 5.5 21h13a2.5 2.5 0 0 0 2.5-2.5v-6a2.5 2.5 0 0 0-2.5-2.5H17"/>',
      download: '<path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M5 20h14"/>',
      rename: '<path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/><path d="m14.5 6.7 2.8 2.8"/>',
      move: '<path d="M3.5 8.5h17v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Zm0 0V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v.5"/><path d="M9 14h6m0 0-2-2m2 2-2 2"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
      dashboard: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
      cloud: '<path d="M7.5 18.5h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3-2A5 5 0 0 0 7.5 18.5Z"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      wave: '<path d="M4 12h2.5l2-5 3 10 2.5-7 2 4h4"/>',
      logout: '<path d="M14 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3M10 12h11m0 0-3-3m3 3-3 3"/>',
      retry: '<path d="M20 7v5h-5"/><path d="M18.7 15.8A8 8 0 1 1 19.5 9"/>',
    };
    return `<svg class="action-svg" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  }

  function renderTableRow(f) {
    const name = U.fName(f);
    const fp = U.fPath(f);
    const d = U.isDir(f);
    const sz = d ? '-' : U.size(f.size);
    const dt = f.lastModified || f.last_modified || '';
    const tp = d ? '目录' : ((name.split('.').pop() || '?').toUpperCase());
    const selected = S.selectedPaths.has(fp) ? ' selected' : '';
    // 目录名称可点击进入
    const nameLink = d ? `<span class="fname" data-action="cd-${U.esc(fp)}" style="cursor:pointer;color:var(--yellow-700);">${U.esc(name)}</span>` : `<span class="fname">${U.esc(name)}</span>`;

    return `<tr class="${selected}" data-path="${U.esc(fp)}" data-type="${d ? 'directory' : 'file'}">
      <td><input type="checkbox" class="file-checkbox" data-action="select-file" data-path="${U.esc(fp)}" ${selected ? 'checked' : ''}></td>
      <td><div class="file-name">${renderFileIcon(name, d)}${nameLink}</div></td>
      <td class="file-size"><span class="file-type">${tp}</span><span>${sz}</span></td>
      <td class="file-date">${U.date(dt)}</td>
      <td><div class="file-actions">
        <button class="btn btn-ghost btn-sm text-action primary-text-action" title="分享" aria-label="分享" data-action="share-${d ? 'directory' : 'file'}-${U.esc(fp)}">${actionIcon('share')}<span class="action-label">分享</span></button>
        ${d ? '' : `<button class="btn btn-ghost btn-sm text-action" title="下载" aria-label="下载" data-action="dl-${U.esc(fp)}">${actionIcon('download')}<span class="action-label">下载</span></button>`}
        ${d ? '' : `<button class="btn btn-ghost btn-sm text-action" title="重命名" aria-label="重命名" data-action="rn-${U.esc(fp)}">${actionIcon('rename')}<span class="action-label">重命名</span></button>`}
        ${d ? '' : `<button class="btn btn-ghost btn-sm text-action" title="移动" aria-label="移动" data-action="mv-${U.esc(fp)}">${actionIcon('move')}<span class="action-label">移动</span></button>`}
        ${d ? '' : `<button class="btn btn-ghost btn-sm text-action" title="详情" aria-label="详情" data-action="detail-${U.esc(fp)}">${actionIcon('info')}<span class="action-label">详情</span></button>`}
        <button class="btn btn-ghost btn-sm text-action danger-text-action" title="删除" aria-label="删除" data-action="del-${U.esc(fp)}">${actionIcon('trash')}<span class="action-label">删除</span></button>
      </div></td>
    </tr>`;
  }

  function renderGridItem(f) {
    const name = U.fName(f);
    const fp = U.fPath(f);
    const d = U.isDir(f);
    const sz = d ? '' : U.size(f.size);
    const selected = S.selectedPaths.has(fp) ? ' selected' : '';

    return `<div class="file-grid-item${selected}" data-path="${U.esc(fp)}" data-type="${d ? 'directory' : 'file'}">
      <input type="checkbox" class="file-checkbox grid-check" data-action="select-file" data-path="${U.esc(fp)}" ${selected ? 'checked' : ''}>
      <div class="grid-icon"${d ? ` data-action="cd-${U.esc(fp)}"` : ''} style="${d ? 'cursor:pointer;' : ''}">${renderFileIcon(name, d, 'ficon-large')}</div>
      <div class="grid-name" title="${U.esc(name)}"${d ? ` data-action="cd-${U.esc(fp)}"` : ''} style="${d ? 'cursor:pointer;' : ''}">${U.esc(name)}</div>
      <div class="grid-meta">${sz}</div>
    </div>`;
  }

  // ============================================================
  //  文件操作
  // ============================================================

  function downloadFile(fp) {
    const url = API.getFileDownloadUrl(fp);
    const a = document.createElement('a');
    a.href = url;
    a.download = fp.split('/').pop() || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Toast.success('下载', '已开始下载 ' + fp.split('/').pop());
  }

  function showDeleteConfirm(fp, type = 'file') {
    const isDirectory = type === 'directory';
    showModal('确认删除', `
      <p style="margin-bottom:8px;">确定要删除以下${isDirectory ? '文件夹及其全部内容' : '文件'}吗？</p>
      <p style="background:var(--gray-50);padding:8px 12px;border-radius:6px;font-size:13px;word-break:break-all;">${U.esc(fp)}</p>
      <p style="font-size:12px;color:var(--red-500);margin-top:8px;">此操作不可撤销</p>
    `, [
      { text: '取消', cls: 'btn-outline', action: closeModal },
      { text: '确认删除', cls: 'btn-danger', action: () => doDelete(fp, type) },
    ]);
  }

  async function doDelete(fp, type) {
    closeModal();
    try {
      await API.deleteFile(fp, type);
      invalidateStorageViews({ directoryTree:true, trash:true, repository:true });
      Toast.success('删除成功', fp.split('/').pop());
      loadFiles(S.dir, { force:true });
    } catch (e) { Toast.error('删除失败', e.message); }
  }

  function showRenameModal(fp) {
    const parts = fp.split('/');
    const oldName = parts.pop() || '';
    const dir = parts.join('/');
    showModal('重命名', `
      <div class="form-group"><label>当前文件名</label><div class="form-input" style="background:var(--gray-50);">${U.esc(oldName)}</div></div>
      <div class="form-group"><label>新文件名</label><input class="form-input" id="rename-input" value="${U.esc(oldName)}"></div>
    `, [
      { text: '取消', cls: 'btn-outline', action: closeModal },
      { text: '确认', cls: 'btn-primary', action: () => doRename(fp, dir) },
    ]);
    setTimeout(() => { const el = qs('#rename-input'); if (el) { el.focus(); el.select(); } }, 100);
  }

  async function doRename(oldPath, dir) {
    const input = qs('#rename-input');
    const newName = input ? input.value.trim() : '';
    if (!newName) { Toast.warning('提示', '请输入新文件名'); return; }
    closeModal();
    const newPath = dir ? dir + '/' + newName : newName;
    try {
      try {
        await API.renameFile(oldPath, newPath, 'reject');
      } catch (error) {
        if (window.confirm('目标名称已存在，是否覆盖？')) await API.renameFile(oldPath,newPath,'overwrite');
        else if (window.confirm('是否自动重命名？')) await API.renameFile(oldPath,newPath,'rename');
        else throw error;
      }
      invalidateStorageViews();
      Toast.success('重命名成功', `${oldPath.split('/').pop()} → ${newName}`);
      loadFiles(S.dir, { force:true });
    } catch (e) { Toast.error('重命名失败', e.message); }
  }

  // --- 目录选择器 ---
  const DIRECTORY_CACHE_TTL = 5 * 60 * 1000;
  let directoryPathCache = null;
  let directoryPathCacheTime = 0;
  let directoryPathRequest = null;

  async function getDirectoryPaths() {
    if (directoryPathCache && Date.now() - directoryPathCacheTime < DIRECTORY_CACHE_TTL) {
      return directoryPathCache;
    }
    if (directoryPathRequest) return directoryPathRequest;

    directoryPathRequest = API.getDirectoryTree().then(result => {
      const dirSet = new Set();
      if (Array.isArray(result.directories)) {
        result.directories.forEach(d => { if (d.path) dirSet.add(d.path); });
      }
      const paths = Array.from(dirSet).sort((a, b) => a.localeCompare(b));
      directoryPathCache = paths;
      directoryPathCacheTime = Date.now();
      return paths;
    }).finally(() => { directoryPathRequest = null; });

    return directoryPathRequest;
  }

  function invalidateDirectoryCache() {
    directoryPathCache = null;
    directoryPathCacheTime = 0;
  }

  function invalidateStorageViews({ directoryTree = false, trash = false, repository = false } = {}) {
    invalidateCachedViews('files:', 'recent:');
    if (directoryTree) invalidateDirectoryCache();
    if (trash) TrashPage.invalidate();
    if (repository) {
      repoInfoCache = null;
      repoInfoCacheTime = 0;
    }
  }

  function handleTrashMutation(action) {
    if (action === 'restore') invalidateStorageViews({ directoryTree:true, repository:true });
    else if (action === 'purge' || action === 'empty') {
      repoInfoCache = null;
      repoInfoCacheTime = 0;
    }
  }

  function warmDirectoryCache() {
    getDirectoryPaths().catch(() => {});
  }

  async function showDirPicker(currentDir, callback) {
    const title = '选择目录';

    // 先显示加载状态
    showModal(title, '<div class="loading-overlay" style="min-height:200px;display:flex;align-items:center;justify-content:center;"><div class="loading-spinner"></div><span style="margin-left:12px;color:var(--gray-500);">加载目录...</span></div>', [
      { text: '取消', cls: 'btn-outline', action: closeModal },
    ]);

    // 加载目录列表
    let dirs = [];
    try {
      dirs = await getDirectoryPaths();
    } catch {}

    // 构建树形结构
    function buildTree(paths) {
      const root = { name: '', children: {} };
      paths.forEach(p => {
        const segments = p.split('/');
        let node = root;
        segments.forEach((seg, i) => {
          if (!node.children[seg]) {
            node.children[seg] = {
              name: seg, fullPath: segments.slice(0, i + 1).join('/'), children: {},
            };
          }
          node = node.children[seg];
        });
      });
      return root;
    }

    const tree = buildTree(dirs);
    // 展开状态：默认全部收起
    const expanded = new Set();
    // 如果当前选中目录有父路径，展开其祖先
    if (currentDir) {
      const parts = currentDir.split('/');
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        expanded.add(acc);
      }
    }

    let selectedDirCache = currentDir || '';

    function renderDirTree() {
      function renderNode(node, depth) {
        const keys = Object.keys(node.children).sort();
        let html = '';
        keys.forEach(key => {
          const child = node.children[key];
          const hasChildren = Object.keys(child.children).length > 0;
          const isExpanded = expanded.has(child.fullPath);
          const indent = depth * 24;
          const toggleHtml = hasChildren
            ? `<span class="dir-toggle">${isExpanded ? '▼' : '▶'}</span>`
            : `<span class="dir-toggle">&nbsp;&nbsp;&nbsp;</span>`;
          const icon = '📁';
          html += `<div class="dir-picker-item${selectedDirCache === child.fullPath ? ' selected' : ''}" data-dir="${U.esc(child.fullPath)}"${hasChildren ? ' data-has-children="1"' : ''} style="padding-left:${12 + indent}px;">
            ${toggleHtml} ${icon} ${U.esc(child.name)}
          </div>`;
          if (isExpanded) html += renderNode(child, depth + 1);
        });
        return html;
      }
      return renderNode(tree, 0);
    }

    function renderPicker() {
      const treeHtml = renderDirTree();
      const listHtml = treeHtml || '<p style="text-align:center;color:var(--gray-400);padding:32px 0;">暂无目录</p>';
      const bodyHtml = `
        <div class="dir-picker-root${selectedDirCache === '' ? ' selected' : ''}" data-dir="">📂 根目录 /</div>
        <div class="dir-picker-list">${listHtml}</div>
      `;

      showModal(title, bodyHtml, [
        { text: '取消', cls: 'btn-outline', action: closeModal },
        {
          text: '确认',
          cls: 'btn-primary',
          action: () => { closeModal(); callback(selectedDirCache); },
        },
      ]);

      // 单击选择，双击展开/收起
      let clickTimer = null;
      let clickTarget = null;

      function selectDir(dir) {
        qsa('.dir-picker-item, .dir-picker-root').forEach(el => el.classList.remove('selected'));
        const target = dir === '' ? qs('.dir-picker-root') : qs(`.dir-picker-item[data-dir="${U.esc(dir)}"]`);
        if (target) target.classList.add('selected');
        selectedDirCache = dir;
      }

      function toggleDir(dir) {
        if (expanded.has(dir)) expanded.delete(dir);
        else expanded.add(dir);
        renderPicker();
      }

      const container = qs('.dir-picker-list') || qs('.modal-body');
      if (container) {
        container.addEventListener('click', (e) => {
          const item = e.target.closest('.dir-picker-item, .dir-picker-root');
          if (!item) return;
          e.stopPropagation();
          const dir = item.dataset.dir || '';

          if (clickTimer && clickTarget === item) {
            // 双击 → 展开/收起
            clearTimeout(clickTimer);
            clickTimer = null;
            clickTarget = null;
            if (item.dataset.hasChildren && dir !== '') toggleDir(dir);
            return;
          }

          // 单击（延迟执行，等待可能的双击）
          clickTimer = setTimeout(() => {
            clickTimer = null;
            clickTarget = null;
            selectDir(dir);
          }, 250);
          clickTarget = item;
        });
      }
    }

    renderPicker();
  }

  // --- 移动文件 ---
  function showMoveModal(fp) {
    const parts = fp.split('/');
    const fileName = parts.pop() || '';
    const currentDir = parts.join('/');
    let targetDir = currentDir;

    function renderMoveModal() {
      showModal('移动文件', `
        <div class="form-group"><label>文件</label><div class="form-input" style="background:var(--gray-50);font-size:13px;">${U.esc(fp)}</div></div>
        <div class="form-group"><label>目标目录</label>
          <div class="input-group" style="display:flex;gap:4px;">
            <input class="form-input" id="move-dir-input" placeholder="根目录，如 images/subfolder" value="${U.esc(targetDir)}" style="flex:1;">
            <button class="btn btn-outline" data-action="pick-move-dir" title="选择已有目录">📁 选择</button>
          </div>
        </div>
        <div class="form-group"><label>预览新路径</label><div class="form-input" style="background:var(--gray-50);font-size:13px;" id="move-preview">${U.esc(targetDir ? targetDir + '/' + fileName : fileName)}</div></div>
      `, [
        { text: '取消', cls: 'btn-outline', action: closeModal },
        { text: '确认移动', cls: 'btn-primary', action: () => doMove(fp) },
      ]);

      // 绑定选择按钮
      const pickBtn = document.querySelector('[data-action="pick-move-dir"]');
      if (pickBtn) {
        pickBtn.addEventListener('click', () => {
          const input = qs('#move-dir-input');
          const cur = input ? input.value.trim().replace(/^\/+|\/+$/g, '') : '';
          showDirPicker(cur, (selected) => {
            targetDir = selected || '';
            if (input) input.value = targetDir;
            renderMoveModal();
          });
        });
      }
      // 输入框自动预览
      const input = qs('#move-dir-input');
      if (input) {
        input.addEventListener('input', () => {
          targetDir = input.value.trim().replace(/^\/+|\/+$/g, '');
          const preview = qs('#move-preview');
          if (preview) preview.textContent = targetDir ? targetDir + '/' + fileName : fileName;
        });
      }
    }

    renderMoveModal();
  }

  async function doMove(oldPath) {
    const input = qs('#move-dir-input');
    const targetDir = input ? input.value.trim().replace(/^\/+|\/+$/g, '') : '';
    const fileName = oldPath.split('/').pop() || '';
    const newPath = targetDir ? targetDir + '/' + fileName : fileName;
    if (newPath === oldPath) { Toast.warning('提示', '目标路径与原路径相同'); return; }
    closeModal();
    try {
      await API.renameFile(oldPath, newPath);
      invalidateStorageViews({ directoryTree:true });
      Toast.success('移动成功', `${fileName} → ${targetDir || '根目录'}`);
      loadFiles(S.dir, { force:true });
    } catch (e) { Toast.error('移动失败', e.message); }
  }

  // --- 文件详情面板 ---
  async function showDetail(fp) {
    const panel = qs('#detail-panel');
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    S.currentFile = fp;
    panel.style.display = 'flex';
    const knownFile = S.files.find(file => U.fPath(file) === fp);
    const knownMeta = {
      contentLength: knownFile?.size || 0,
      lastModified: knownFile?.lastModified || knownFile?.last_modified || null,
    };
    renderDetail(fp, knownMeta);

    try {
      const metaResult = await API.getFileMeta(fp, { signal: controller.signal });
      if (controller.signal.aborted || S.currentFile !== fp) return;
      const remoteMeta = metaResult?.metadata || {};
      renderDetail(fp, {
        ...knownMeta,
        ...remoteMeta,
        contentLength: remoteMeta.contentLength || knownMeta.contentLength,
        lastModified: remoteMeta.lastModified || knownMeta.lastModified,
      });
    } catch (error) {
      if (error.name === 'AbortError') return;
    } finally {
      if (detailController === controller) detailController = null;
    }
  }

  function renderDetail(fp, meta) {
    if (S.currentFile !== fp) return;
    qs('#detail-panel-body').innerHTML = `
        <div style="text-align:center;margin-bottom:16px;"><span style="font-size:48px;">${U.icon(fp, '')}</span></div>
        <div class="detail-row"><div class="detail-label">文件名</div><div class="detail-value">${U.esc(fp.split('/').pop())}</div></div>
        <div class="detail-row"><div class="detail-label">路径</div><div class="detail-value">${U.esc(fp)}</div></div>
        <div class="detail-row"><div class="detail-label">大小</div><div class="detail-value">${meta.contentLength ? U.size(meta.contentLength) : '-'}</div></div>
        <div class="detail-row"><div class="detail-label">类型</div><div class="detail-value">${meta.contentType || '-'}</div></div>
        <div class="detail-row"><div class="detail-label">修改时间</div><div class="detail-value">${meta.lastModified ? U.date(meta.lastModified) : '-'}</div></div>
        <div class="detail-row"><div class="detail-label">ETag</div><div class="detail-value" style="font-size:11px;">${meta.etag || '-'}</div></div>
        <div style="margin-top:16px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" data-action="dl-${U.esc(fp)}">下载</button>
          <button class="btn btn-sm btn-outline" data-action="rn-${U.esc(fp)}">重命名</button>
          <button class="btn btn-sm btn-outline" data-action="mv-${U.esc(fp)}">移动</button>
          <button class="btn btn-sm btn-outline" data-action="share-file-${U.esc(fp)}">分享</button>
          <button class="btn btn-sm btn-danger" data-action="del-${U.esc(fp)}">删除</button>
        </div>`;
  }

  function closeDetail() {
    detailController?.abort();
    detailController = null;
    S.currentFile = null;
    qs('#detail-panel').style.display = 'none';
  }

  // --- 右键菜单 ---
  function showContextMenu(e, fp) {
    e.preventDefault();
    S.contextFile = fp;
    const d = e.target.closest('[data-type]')?.dataset.type === 'directory';
    S.contextIsDirectory = d;
    const menu = qs('#context-menu');

    let items = '';
    if (!d) {
      items += `<div class="ctx-item" data-action="ctx-dl">⬇ 下载</div>`;
      items += `<div class="ctx-item" data-action="ctx-rn">✏ 重命名</div>`;
      items += `<div class="ctx-item" data-action="ctx-detail">ℹ 详情</div>`;
      items += `<div class="ctx-sep"></div>`;
    }
    items += `<div class="ctx-item" data-action="ctx-share">🔗 分享</div>`;
    items += `<div class="ctx-item danger" data-action="ctx-del">🗑 删除</div>`;

    menu.innerHTML = items;
    menu.style.display = 'block';

    // 定位
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideContextMenu() {
    qs('#context-menu').style.display = 'none';
  }

  // --- 搜索 ---
  async function doSearch(q) {
    if (!q) { loadFiles(S.dir); return; }
    fileListController?.abort();
    fileListController = null;
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    const body = qs('#files-body');
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>搜索中...</span></div>';
    try {
      const result = await API.listDirectory('', { search: q, recursive: true, signal: controller.signal });
      const files = result.files || [];
      Toast.info('搜索结果', `找到 ${files.length} 个匹配文件`);
      renderBreadcrumb();
      renderFileList(files);
    } catch (e) {
      if (e.name === 'AbortError') return;
      Toast.error('搜索失败', e.message);
    } finally {
      if (searchController === controller) searchController = null;
    }
  }

  // ============================================================
  //  最近上传
  // ============================================================
  let recentPage = 1;

  async function loadRecent(page = 1, { force = false } = {}) {
    recentController?.abort();
    const controller = new AbortController();
    recentController = controller;
    const body = qs('#recent-body');
    const cacheKey = `recent:${page}`;
    let result = force ? null : getCachedView(cacheKey);
    if (!result) body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
    try {
      if (!result) {
        result = await API.listRecent(page, { signal: controller.signal });
        setCachedView(cacheKey, result);
      }
      if (controller.signal.aborted || S.page !== 'recent') return;
      const files = result.files || [];
      const pagination = result.pagination || { page: 1, totalPages: 1, totalFiles: files.length };
      recentPage = pagination.page;
      S.files = files;
      if (files.length === 0) {
        body.innerHTML = '<div class="empty-state"><div class="empty-icon">🕐</div><h3>暂无文件</h3><p>上传文件后将在此显示</p></div>';
        return;
      }
      body.innerHTML = `<table class="file-table"><thead><tr>
        <th style="width:60%;">文件名</th><th style="width:15%;">大小</th><th style="width:25%;">修改时间</th>
      </tr></thead><tbody>${files.map(f => {
        const name = U.fName(f);
        return `<tr>
          <td><div class="file-name"><span class="ficon">${U.icon(name, f.type)}</span><span class="fname">${U.esc(name)}</span></div></td>
          <td class="file-size">${U.size(f.size)}</td>
          <td class="file-date">${U.date(f.lastModified || f.last_modified)}</td>
        </tr>`;
      }).join('')}</tbody></table>
        <div class="recent-pagination" aria-label="最近上传分页">
          <span>共 ${pagination.totalFiles} 个文件</span>
          <div><button class="btn btn-sm btn-outline" data-action="recent-prev" ${recentPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${recentPage} / ${pagination.totalPages} 页</span>
          <button class="btn btn-sm btn-outline" data-action="recent-next" ${recentPage >= pagination.totalPages ? 'disabled' : ''}>下一页</button></div>
        </div>`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>加载失败</h3><p>${U.esc(e.message)}</p></div>`;
    } finally {
      if (recentController === controller) recentController = null;
    }
  }

  // ============================================================
  //  分享
  // ============================================================
  function showShareModal(fp, type) {
    const label = type === 'directory' ? '文件夹' : '文件';
    showModal(`分享${label}`, `
      <div class="share-target"><span>${type === 'directory' ? '📁' : '📄'}</span><div><strong>${U.esc(fp.split('/').pop())}</strong><small>${U.esc(fp)}</small></div></div>
      <div class="form-group"><label for="share-expiry">有效期</label><select class="form-input" id="share-expiry">
        <option value="3600">1 小时</option><option value="86400">1 天</option><option value="604800" selected>7 天</option>
        <option value="2592000">30 天</option><option value="0">永久有效</option>
      </select></div>
      <div class="form-group"><label for="share-password">访问密码（可选）</label><input class="form-input" id="share-password" type="password" maxlength="128" autocomplete="new-password" placeholder="留空表示无需密码"></div>
      <p class="form-hint">任何获得链接的人都能访问未设置密码的分享。撤销后链接立即失效。</p>
    `, [
      { text:'取消',cls:'btn-outline',action:closeModal },
      { text:'创建分享',cls:'btn-primary',id:'confirm-create-share',action:()=>createShare(fp,type) },
    ]);
  }

  async function createShare(fp, type) {
    const button=qs('#confirm-create-share');
    button.disabled=true; button.textContent='创建中...';
    try {
      const expiresIn=Number(qs('#share-expiry').value);
      const password=qs('#share-password').value;
      const result=await API.createShare(fp,type,expiresIn,password);
      invalidateCachedViews('shares:');
      showShareResult(result.share);
    } catch(error) {
      button.disabled=false; button.textContent='创建分享';
      Toast.error('创建分享失败',error.message);
    }
  }

  function showShareResult(share) {
    showModal('分享创建成功', `
      <div class="share-success-icon">✓</div>
      <p class="share-success-title">分享链接已生成</p>
      <div class="share-link-box"><input class="form-input" id="created-share-url" value="${U.esc(share.url)}" readonly><button class="btn btn-primary" data-action="copy-created-share">复制链接</button></div>
      <div class="share-summary"><span>${share.passwordProtected ? '🔒 已设置访问密码' : '🔓 无访问密码'}</span><span>${share.expiresAt ? `到期：${U.date(share.expiresAt)}` : '永久有效'}</span></div>
    `,[{ text:'完成',cls:'btn-primary',action:closeModal }]);
  }

  let sharePage=1;
  async function loadShares(page=sharePage,{ force = false } = {}) {
    sharesController?.abort();
    const controller = new AbortController();
    sharesController = controller;
    const body=qs('#shares-body');
    const cacheKey=`shares:${page}`;
    let result=force?null:getCachedView(cacheKey);
    if(!result) body.innerHTML='<div class="loading-state"><div class="spinner"></div><span>加载中...</span></div>';
    try {
      if(!result){
        result=await API.listShares(page,{signal:controller.signal});
        setCachedView(cacheKey,result);
      }
      if(controller.signal.aborted||S.page!=='shares')return;
      const { shares=[] }=result;
      const pagination=result.pagination||{page:1,limit:20,totalShares:shares.length,totalPages:1};
      sharePage=pagination.page||1;
      if(!shares.length){
        body.innerHTML='<div class="empty-state"><div class="empty-icon">🔗</div><h3>暂无分享</h3><p>在“全部文件”中点击分享按钮创建链接</p></div>';
        return;
      }
      body.innerHTML=`<div class="share-list">${shares.map(share=>`
        <article class="share-card ${share.expired?'expired':''}">
          <div class="share-card-icon">${share.type==='directory'?'📁':'📄'}</div>
          <div class="share-card-main"><div class="share-card-title">${U.esc(share.name)}</div><div class="share-card-path">${U.esc(share.path)}</div>
            <div class="share-card-meta"><span>${share.passwordProtected?'🔒 密码保护':'🔓 无密码'}</span><span>创建于 ${U.date(share.createdAt)}</span><span class="${share.expired?'status-expired':''}">${share.expired?'已过期':share.expiresAt?`到期 ${U.date(share.expiresAt)}`:'永久有效'}</span></div>
          </div>
          <div class="share-card-actions"><button class="btn btn-sm btn-primary share-copy-button" data-action="copy-share-${U.esc(share.id)}" data-url="${U.esc(share.url)}"><span aria-hidden="true">⧉</span> 复制链接</button><button class="btn btn-sm btn-outline share-revoke-button" data-action="revoke-share-${U.esc(share.id)}">取消分享</button></div>
        </article>`).join('')}</div>
        <div class="recent-pagination"><span>第 ${sharePage} / ${pagination.totalPages} 页 · 共 ${pagination.totalShares} 条</span><div><button class="btn btn-sm btn-outline" data-action="shares-prev" ${sharePage<=1?'disabled':''}>上一页</button><button class="btn btn-sm btn-outline" data-action="shares-next" ${sharePage>=pagination.totalPages?'disabled':''}>下一页</button></div></div>`;
    } catch(error){
      if(error.name==='AbortError')return;
      body.innerHTML=`<div class="empty-state"><div class="empty-icon">⚠️</div><h3>加载失败</h3><p>${U.esc(error.message)}</p></div>`;
    } finally {
      if(sharesController===controller)sharesController=null;
    }
  }

  async function copyText(value) {
    if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input=document.createElement('textarea'); input.value=value; input.style.position='fixed'; input.style.opacity='0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    Toast.success('复制成功','分享链接已复制到剪贴板');
  }

  function showRevokeShareConfirm(id) {
    showModal('撤销分享','<p>撤销后，任何人都无法再通过该链接访问文件。此操作不会删除原文件。</p>',[
      { text:'取消',cls:'btn-outline',action:closeModal },
      { text:'确认撤销',cls:'btn-danger',action:async()=>{ try{ await API.revokeShare(id); invalidateCachedViews('shares:'); closeModal(); Toast.success('已撤销','分享链接已失效'); loadShares(sharePage,{force:true}); }catch(error){ Toast.error('撤销失败',error.message); } } },
    ]);
  }

  // ============================================================
  //  上传
  // ============================================================
  let uploadQueue = [];
  let uploading = false;
  let uploadItemId = 0;
  let uploadCompletionNotified = false;

  function initUpload() {
    const zone = qs('#upload-zone');
    const fileInput = qs('#file-input');

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    zone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) { addFiles(fileInput.files); fileInput.value = ''; }
    });
  }

  function addFiles(fileList) {
    const dirInput = qs('#upload-dir-input');
    const dir = dirInput ? dirInput.value.trim().replace(/^\/+|\/+$/g, '') : '';
    let duplicateCount = 0;
    for (const file of fileList) {
      const duplicate = uploadQueue.some(item => item.dir === dir
        && item.file?.name === file.name
        && item.file?.size === file.size
        && item.file?.lastModified === file.lastModified
        && item.status !== 'error');
      if (duplicate) { duplicateCount++; continue; }
      uploadQueue.push({
        id: ++uploadItemId, file, dir, status: 'pending', progress: 0,
        isLfs: file.size >= LARGE_FILE_THRESHOLD,
        lfsInfo: null, errorText: '',
      });
    }
    if (duplicateCount) Toast.info('已忽略重复文件', `${duplicateCount} 个文件已在传输列表中`);
    uploadCompletionNotified = false;
    renderQueue();
    if (!uploading) processQueue();
  }

  function formatSpeed(bps) {
    if (!bps || bps <= 0) return '';
    if (bps < 1024) return bps.toFixed(0) + ' B/s';
    if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  }

  function renderQueue() {
    const area = qs('#upload-progress-area');
    const queue = qs('#upload-queue');
    if (!area || !queue) return;
    if (uploadQueue.length === 0) { area.style.display = 'none'; return; }
    area.style.display = 'block';
    const totalBytes = uploadQueue.reduce((sum, item) => sum + (item.file?.size || 0), 0);
    const transferredBytes = uploadQueue.reduce((sum, item) => sum + (item.file?.size || 0) * (item.progress || 0) / 100, 0);
    const overallPct = totalBytes ? Math.round(transferredBytes / totalBytes * 100) : 0;
    const doneCount = uploadQueue.filter(item => item.status === 'done').length;
    const countNode = qs('#upload-queue-count');
    const totalNode = qs('#upload-total-size');
    const percentNode = qs('#upload-overall-percent');
    const fillNode = qs('#upload-overall-fill');
    if (countNode) countNode.textContent = `${uploadQueue.length} 个项目 · ${doneCount} 个完成`;
    if (totalNode) totalNode.textContent = `共 ${U.size(totalBytes)}`;
    if (percentNode) percentNode.textContent = `${overallPct}%`;
    if (fillNode) fillNode.style.width = `${overallPct}%`;

    queue.innerHTML = uploadQueue.map(item => {
      const name = U.esc(item.file?.name || item.fileName || 'unknown');
      const pct = Math.round(item.progress || 0);
      const info = item.lfsInfo;
      const stageNames = {
        hashing: '计算哈希', signing: '获取签名', encoding: '编码分片',
        uploading: '上传分片', committing: '提交引用', done: '完成',
      };
      const statusLabels = { pending:'等待上传', uploading:info ? (stageNames[info.stage] || '上传中') : '上传中', done:'已完成', error:'上传失败' };
      const targetPath = item.dir ? item.dir : '根目录';
      const lfsTag = item.isLfs ? '<span class="upload-tag lfs">大文件</span>' : '';
      const actionHtml = item.status === 'error'
        ? `<button class="upload-item-action retry" data-action="retry-upload-${item.id}" aria-label="重试上传" title="重试">${actionIcon('retry')}</button><button class="upload-item-action" data-action="remove-upload-${item.id}" aria-label="移除" title="移除">${actionIcon('trash')}</button>`
        : item.status === 'uploading' ? ''
          : `<button class="upload-item-action" data-action="remove-upload-${item.id}" aria-label="移除" title="移除">${actionIcon('trash')}</button>`;
      const detail = item.status === 'error' && item.errorText
        ? U.esc(item.errorText)
        : item.status === 'uploading' ? `${U.size((item.file?.size || 0) * pct / 100)} / ${U.size(item.file?.size || 0)}`
          : `${U.size(item.file?.size || 0)} · ${U.esc(targetPath)}`;

      let chunkHtml = '';
      if (info?.chunkTotal > 1 && (info.stage === 'uploading' || info.stage === 'encoding')) {
        const activeIndex = Math.max(0, info.chunkIndex || 0);
        const firstIndex = Math.max(0, activeIndex - 1);
        const lastIndex = Math.min(info.chunkTotal, firstIndex + 3);
        const chunks = [];
        for (let i = firstIndex; i < lastIndex; i++) {
          const chunk = info.chunks?.[i] || null;
          const isActive = chunk ? chunk.status === 'uploading' : i === info.chunkIndex;
          const isDone = chunk ? chunk.status === 'done' : i < info.chunkIndex;
          const chunkSize = chunk?.size || info.chunkSize || 0;
          const chunkLoaded = chunk?.loaded ?? (isDone ? chunkSize : (isActive ? info.chunkLoaded : 0));
          const chunkPct = chunkSize ? Math.round(chunkLoaded / chunkSize * 100) : (isDone ? 100 : 0);
          const stateClass = isDone ? 'done' : (isActive ? 'active' : 'pending');
          const speedText = isActive && i === info.chunkIndex ? formatSpeed(info.speed) : '';
          chunks.push(`<div class="lfs-chunk ${stateClass}"><span class="lfs-chunk-label">分片 ${i + 1}/${info.chunkTotal}</span><div class="lfs-chunk-bar"><i class="lfs-chunk-fill" style="width:${chunkPct}%"></i></div><span class="lfs-chunk-detail">${isDone ? '完成' : isActive ? `${chunkPct}%${speedText ? ` · ${speedText}` : ''}` : '等待'}</span></div>`);
        }
        chunkHtml = `<div class="lfs-chunks">${chunks.join('')}</div>`;
      }

      return `<article class="upload-queue-entry ${item.status}">
        <div class="upload-item">
          <div class="upload-item-icon">${renderFileIcon(item.file?.name || '', false, 'ficon-large')}</div>
          <div class="upload-item-info">
            <div class="upload-item-title"><span class="upload-item-name">${name}</span>${lfsTag}</div>
            <div class="upload-item-detail">${detail}</div>
            <div class="upload-item-bar"><div class="upload-item-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="upload-item-side">
            <span class="upload-status ${item.status}"><i></i>${statusLabels[item.status] || ''}</span>
            <strong>${pct}%</strong>
            <div class="upload-item-actions">${actionHtml}</div>
          </div>
        </div>
        ${chunkHtml}
      </article>`;
    }).join('');
  }

  const scheduleQueueRender = createFrameScheduler(renderQueue);

  const LARGE_FILE_THRESHOLD = 95 * 1024 * 1024; // 95MB

  async function processQueue() {
    if (uploadQueue.length === 0 || uploading) return;
    uploading = true;
    const idx = uploadQueue.findIndex(i => i.status === 'pending');
    if (idx === -1) {
      uploading = false;
      const completed = uploadQueue.filter(i => i.status === 'done').length;
      if (completed && completed === uploadQueue.length && !uploadCompletionNotified) {
        uploadCompletionNotified = true;
        Toast.success('上传完成', `${completed} 个文件已安全保存到云端`);
      }
      return;
    }
    const item = uploadQueue[idx];
    item.status = 'uploading'; item.progress = 0;
    renderQueue();
    try {
      const conflictPolicy = await chooseConflictPolicy(item);
      if (item.isLfs) {
        // 大文件：LFS 分片上传
        await API.uploadLfsWithProgress(item.file, item.dir, '', (info) => {
          item.progress = info.pct;
          item.lfsInfo = info;
          scheduleQueueRender();
        }, conflictPolicy);
      } else {
        // 小文件：Worker 代理上传
        await API.uploadFileWithProgress(item.file, item.dir, '', (pct) => {
          item.progress = pct;
          scheduleQueueRender();
        }, conflictPolicy);
      }
      item.status = 'done'; item.progress = 100;
      invalidateStorageViews({ directoryTree:true, repository:true });
      renderQueue();
    } catch (e) {
      item.status = 'error';
      item.errorText = e.message || '上传未完成';
      Toast.error('上传失败', `${item.file?.name}: ${e.message}`);
      renderQueue();
    }
    uploading = false;
    setTimeout(() => processQueue(), 300);
  }

  function clearUploadQueue() {
    uploadQueue = uploadQueue.filter(i => i.status !== 'done');
    if (uploadQueue.length === 0) {
      const area = qs('#upload-progress-area');
      if (area) area.style.display = 'none';
    }
    renderQueue();
  }

  function removeUploadItem(id) {
    const item = uploadQueue.find(entry => entry.id === id);
    if (!item || item.status === 'uploading') return;
    uploadQueue = uploadQueue.filter(entry => entry.id !== id);
    renderQueue();
  }

  function retryUploadItem(id) {
    const item = uploadQueue.find(entry => entry.id === id);
    if (!item || item.status !== 'error') return;
    item.status = 'pending';
    item.progress = 0;
    item.lfsInfo = null;
    item.errorText = '';
    uploadCompletionNotified = false;
    renderQueue();
    if (!uploading) processQueue();
  }

  // ============================================================
  //  仓库概览
  // ============================================================
  async function loadDashboard() {
    const body = qs('#dashboard-body');
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>加载仓库信息...</span></div>';
    try {
      const result = await getRepoInfo();
      if (S.page !== 'dashboard') return;
      // 解包后: result = { info: { id, name, private, size:{sizeInBytes,nbFiles}, downloads, likes, tags, ... } }
      const info = result.info || result;
      S.repoInfo = info;
      const size = info.size || {};
      const nbFiles = size.nbFiles || 0;
      const sizeBytes = size.sizeInBytes || 0;

      body.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-icon yellow">📊</div><div class="stat-info"><div class="stat-label">文件总数</div><div class="stat-value">${nbFiles}</div><div class="stat-sub">${sizeBytes ? U.size(sizeBytes) : '未知大小'}</div></div></div>
          <div class="stat-card"><div class="stat-icon blue">📥</div><div class="stat-info"><div class="stat-label">下载量</div><div class="stat-value">${info.downloads || 0}</div><div class="stat-sub">总下载次数</div></div></div>
          <div class="stat-card"><div class="stat-icon green">❤️</div><div class="stat-info"><div class="stat-label">点赞数</div><div class="stat-value">${info.likes || 0}</div><div class="stat-sub">仓库热度</div></div></div>
          <div class="stat-card"><div class="stat-icon purple">🏷️</div><div class="stat-info"><div class="stat-label">仓库标签</div><div class="stat-value" style="font-size:13px;">${(info.tags && info.tags.length) ? info.tags.slice(0, 3).join(', ') : '无'}</div><div class="stat-sub">${info.private ? '🔒 私有仓库' : '🔓 公开仓库'}</div></div></div>
        </div>
        <div class="card">
          <div class="card-header"><h3>仓库信息</h3><span class="tag-badge">${info.private ? '私有' : '公开'}</span></div>
          <div class="card-body"><div class="info-grid">
            <div><div style="font-size:11px;color:var(--gray-500);">仓库名称</div><div style="font-size:14px;font-weight:600;">${U.esc(info.name || info.id || '-')}</div></div>
            <div><div style="font-size:11px;color:var(--gray-500);">作者</div><div style="font-size:14px;font-weight:600;">${U.esc(info.author || '-')}</div></div>
            <div><div style="font-size:11px;color:var(--gray-500);">创建时间</div><div style="font-size:14px;font-weight:600;">${info.createdAt ? U.date(info.createdAt) : '-'}</div></div>
            <div><div style="font-size:11px;color:var(--gray-500);">描述</div><div style="font-size:14px;font-weight:600;">${info.description ? U.esc(info.description) : '无描述'}</div></div>
          </div></div>
        </div>
        `;

      updateConnStatus(true);
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><h3>仓库未配置或不存在</h3><p>${U.esc(e.message)}</p><button class="btn btn-primary" style="margin-top:12px;" data-action="nav-settings">前往设置</button></div>`;
      updateConnStatus(false);
    }
  }

  // ============================================================
  //  设置
  // ============================================================
  function loadSettings() {
    const body = qs('#settings-body');
    body.innerHTML = `
      <div class="settings-shell">
        <section class="settings-profile">
          <span class="settings-profile-icon">H</span>
          <div><strong>HF Drive</strong></div>
          <span class="settings-status"><i></i>受保护</span>
        </section>
        <section class="settings-storage" aria-label="存储空间使用情况">
          <div class="settings-storage-heading"><span>存储使用</span><strong id="mobile-storage-percent">--</strong></div>
          <div class="settings-storage-summary"><span id="mobile-storage-usage">正在计算</span><span id="mobile-storage-plan">仓库容量</span></div>
          <div class="storage-track" id="mobile-storage-track" role="progressbar" aria-label="存储空间使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="mobile-storage-fill"></i></div>
        </section>
        <p class="settings-section-label mobile-settings-nav">管理</p>
        <section class="settings-group settings-actions mobile-settings-nav">
          <button type="button" class="settings-action" data-action="nav-dashboard"><span class="settings-row-icon blue">${actionIcon('dashboard')}</span><span>空间概览</span><i>›</i></button>
          <button type="button" class="settings-action" data-action="nav-trash"><span class="settings-row-icon red">${actionIcon('trash')}</span><span>回收站</span><i>›</i></button>
        </section>
        <p class="settings-section-label">连接</p>
        <section class="settings-group">
          <div class="settings-row"><span class="settings-row-icon blue">${actionIcon('cloud')}</span><div><strong>Hugging Face Hub</strong><small>文件存储服务</small></div><span class="settings-row-value">已配置</span></div>
          <div class="settings-row"><span class="settings-row-icon green">${actionIcon('lock')}</span><div><strong>访问凭据</strong><small>仅由服务端安全保存</small></div><span class="settings-row-value">安全</span></div>
        </section>
        <p class="settings-footnote">Token 和仓库信息由服务端安全配置，浏览器不会保存敏感访问凭据。</p>
        <p class="settings-section-label">会话</p>
        <section class="settings-group settings-actions">
          <button type="button" class="settings-action" data-action="test-connection"><span class="settings-row-icon blue">${actionIcon('wave')}</span><span>测试服务连接</span><i>›</i></button>
          <button type="button" class="settings-action danger" data-action="logout"><span class="settings-row-icon red">${actionIcon('logout')}</span><span>退出当前登录</span><i>›</i></button>
        </section>
        <div class="settings-version">HF Drive · Web App</div>
      </div>`;
    getRepoInfo().catch(() => {});
  }

  function showBatchDeleteConfirm() {
    const items = S.files.filter(file => S.selectedPaths.has(U.fPath(file)));
    if (!items.length) return;
    const directories = items.filter(U.isDir).length;
    showModal('确认批量删除', `
      <p>确定将选中的 <strong>${items.length}</strong> 项移入回收站吗？</p>
      <p style="font-size:12px;color:var(--gray-500);margin-top:8px;">包含 ${directories} 个文件夹和 ${items.length - directories} 个文件；文件夹会连同全部内容删除。</p>
    `, [
      { text:'取消', cls:'btn-outline', action:closeModal },
      { text:`删除 ${items.length} 项`, cls:'btn-danger', action:() => doBatchDelete(items) },
    ]);
  }

  async function doBatchDelete(files) {
    closeModal();
    const items = files.map(file => ({ path:U.fPath(file), type:U.isDir(file)?'directory':'file' }));
    try {
      const result = await API.batchDelete(items);
      invalidateStorageViews({ directoryTree:true, trash:true, repository:true });
      (result.results || []).filter(item => item.success).forEach(item => S.selectedPaths.delete(item.path));
      if (result.failed) Toast.warning('批量删除部分完成', `成功 ${result.deleted} 项，失败 ${result.failed} 项`);
      else Toast.success('批量删除成功', `已将 ${result.deleted} 项移入回收站`);
      await loadFiles(S.dir, { force:true });
    } catch (error) {
      Toast.error('批量删除失败', error.message);
      updateBatchDeleteButton();
    }
  }

  function showEmptyTrashConfirm() {
    showModal('确认清空回收站', `
      <p style="margin-bottom:8px;">确定要清空回收站吗？</p>
      <div style="background:var(--red-50,#fef2f2);border:1px solid var(--red-200,#fecaca);color:var(--red-600);padding:10px 12px;border-radius:6px;font-size:13px;">
        回收站中的所有文件和文件夹都将被永久删除，此操作无法撤销。
      </div>
    `, [
      { text:'取消', cls:'btn-outline', action:closeModal },
      { text:'确认清空', cls:'btn-danger', id:'confirm-empty-trash-btn', action:() => {
        closeModal();
        TrashPage.empty().catch(error => Toast.error('清空失败', error.message));
      } },
    ]);
  }

  async function chooseConflictPolicy(item) {
    const path = item.dir ? `${item.dir}/${item.file.name}` : item.file.name;
    try {
      const result = await API.getFileMeta(path);
      const metadata = result.metadata || result;
      if (!metadata.exists) return 'reject';
    } catch {
      return 'reject';
    }
    if (window.confirm(`“${item.file.name}”已存在。是否覆盖现有文件？`)) return 'overwrite';
    if (window.confirm('是否保留两个文件并自动重命名新文件？')) return 'rename';
    throw new Error('已取消上传');
  }

  async function testConnection() {
    try {
      const result = await getRepoInfo();
      const info = result.info || result;
      Toast.success('连接成功', '仓库: ' + (info.name || 'OK'));
      updateConnStatus(true);
    } catch (e) {
      Toast.error('连接失败', e.message);
      updateConnStatus(false);
    }
  }

  // ============================================================
  //  连接状态
  // ============================================================
  function updateStorageUsage(result) {
    const info = result?.info || result || {};
    const usedBytes = Math.max(0, Number(info.size?.sizeInBytes || info.size?.size_in_bytes || 0));
    const totalBytes = info.private ? 100 * 1024 ** 3 : 8 * 1024 ** 4;
    const percentage = Math.min(100, usedBytes / totalBytes * 100);
    const percentageLabel = usedBytes > 0 && percentage < 0.01 ? '<0.01%' : `${percentage.toFixed(2)}%`;
    ['#storage-percent', '#mobile-storage-percent'].forEach(selector => {
      const element = qs(selector);
      if (element) element.textContent = percentageLabel;
    });
    ['#storage-usage', '#mobile-storage-usage'].forEach(selector => {
      const element = qs(selector);
      if (element) element.textContent = `${U.size(usedBytes)} / ${U.size(totalBytes)}`;
    });
    ['#storage-plan', '#mobile-storage-plan'].forEach(selector => {
      const element = qs(selector);
      if (element) element.textContent = info.private ? '私有仓库' : '公开仓库';
    });
    ['#storage-track', '#mobile-storage-track'].forEach(selector => {
      const element = qs(selector);
      if (!element) return;
      element.setAttribute('aria-valuenow', percentage.toFixed(2));
      element.setAttribute('aria-valuetext', percentageLabel);
    });
    ['#storage-fill', '#mobile-storage-fill'].forEach(selector => {
      const element = qs(selector);
      if (element) element.style.width = `${percentage}%`;
    });
  }

  function updateConnStatus(online) {
    const el = qs('#conn-status');
    if (!el) return;
    el.innerHTML = `<span class="status-dot ${online ? 'online' : 'offline'}"></span><span>${online ? '已连接' : '未连接'}</span>`;
  }

  async function checkConnection() {
    try {
      await getRepoInfo();
      updateConnStatus(true);
    } catch {
      updateConnStatus(false);
    }
  }

  // ============================================================
  //  事件委托
  // ============================================================
  function handleAction(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    // 导航
    if (action.startsWith('nav-')) {
      const page = action.slice(4);
      if (page === 'upload') {
        const dirInput = qs('#upload-dir-input');
        if (dirInput) dirInput.value = S.dir || '';
      }
      nav(page);
      return;
    }

    // 目录切换
    if (action.startsWith('cd-')) {
      e.stopPropagation();
      let dir = action.slice(3);
      // 上级目录
      if (dir === 'up') {
        const parts = S.dir.split('/').filter(Boolean);
        parts.pop();
        dir = parts.join('/');
      }
      S.dir = dir;
      if (S.page !== 'files') {
        nav('files');
      } else {
        updateRoute('files', 'push');
        loadFiles(dir);
      }
      return;
    }

    // 刷新
    if (action === 'refresh') { loadFiles(S.dir, { force:true }); return; }
    if (action === 'recent-prev') { loadRecent(Math.max(1, recentPage - 1)); return; }
    if (action === 'recent-next') { loadRecent(recentPage + 1); return; }
    if (action === 'batch-delete') { showBatchDeleteConfirm(); return; }
    if (action === 'load-more') { loadMoreFiles().catch(error=>Toast.error('加载失败',error.message)); return; }

    // 下载
    if (action.startsWith('dl-')) { e.stopPropagation(); downloadFile(action.slice(3)); return; }

    if (action.startsWith('share-file-')) { e.stopPropagation(); showShareModal(action.slice(11),'file'); return; }
    if (action.startsWith('share-directory-')) { e.stopPropagation(); showShareModal(action.slice(16),'directory'); return; }
    if (action === 'shares-prev') { loadShares(Math.max(1,sharePage-1)); return; }
    if (action === 'shares-next') { loadShares(sharePage+1); return; }
    if (action === 'copy-created-share') { copyText(qs('#created-share-url').value).catch(error=>Toast.error('复制失败',error.message)); return; }
    if (action.startsWith('copy-share-')) { copyText(target.dataset.url).catch(error=>Toast.error('复制失败',error.message)); return; }
    if (action.startsWith('revoke-share-')) { showRevokeShareConfirm(action.slice(13)); return; }

    // 删除
    if (action.startsWith('del-')) { e.stopPropagation(); showDeleteConfirm(action.slice(4), target.closest('[data-type]')?.dataset.type || 'file'); return; }

    // 重命名
    if (action.startsWith('rn-')) { e.stopPropagation(); showRenameModal(action.slice(3)); return; }

    // 移动
    if (action.startsWith('mv-')) { e.stopPropagation(); showMoveModal(action.slice(3)); return; }

    // 详情面板
    if (action.startsWith('detail-')) { e.stopPropagation(); showDetail(action.slice(7)); return; }

    // 标签
    // 设置
    if (action === 'test-connection') { testConnection(); return; }
    if (action === 'logout') { AuthUI.logout(); return; }


    if (action === 'clear-upload') { clearUploadQueue(); return; }
    if (action === 'select-upload-files') { qs('#file-input')?.click(); return; }
    if (action.startsWith('remove-upload-')) { removeUploadItem(Number(action.slice(14))); return; }
    if (action.startsWith('retry-upload-')) { retryUploadItem(Number(action.slice(13))); return; }
    if (action.startsWith('trash-restore-')) { TrashPage.restore(action.slice(14)).catch(error=>Toast.error('恢复失败',error.message)); return; }
    if (action.startsWith('trash-purge-')) { TrashPage.purge(action.slice(12)).catch(error=>Toast.error('删除失败',error.message)); return; }
    if (action === 'trash-prev') { TrashPage.previous().catch(error=>Toast.error('加载失败',error.message)); return; }
    if (action === 'trash-next') { TrashPage.next().catch(error=>Toast.error('加载失败',error.message)); return; }
    if (action === 'trash-empty') { showEmptyTrashConfirm(); return; }

    // 上传目录选择
    if (action === 'pick-upload-dir') {
      e.stopPropagation();
      const dirInput = qs('#upload-dir-input');
      const currentDir = dirInput ? dirInput.value.trim().replace(/^\/+|\/+$/g, '') : '';
      showDirPicker(currentDir, (selected) => {
        if (dirInput) dirInput.value = selected || '';
      });
      return;
    }

    // 关闭
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'close-detail') { closeDetail(); return; }
    if (action === 'close-toast') { target.closest('.toast').remove(); return; }

    // 右键菜单操作
    if (action === 'ctx-dl' && S.contextFile) { hideContextMenu(); downloadFile(S.contextFile); return; }
    if (action === 'ctx-rn' && S.contextFile) { hideContextMenu(); showRenameModal(S.contextFile); return; }
    if (action === 'ctx-detail' && S.contextFile) { hideContextMenu(); showDetail(S.contextFile); return; }
    if (action === 'ctx-share' && S.contextFile) { hideContextMenu(); showShareModal(S.contextFile,S.contextIsDirectory?'directory':'file'); return; }
    if (action === 'ctx-del' && S.contextFile) { hideContextMenu(); showDeleteConfirm(S.contextFile, S.contextIsDirectory ? 'directory' : 'file'); return; }

  }

  function handleFileSelectionChange(event) {
    const target=event.target.closest('[data-action="select-file"], [data-action="select-all"]');
    if(!target)return;
    if(target.dataset.action==='select-file'){
      const filePath=target.dataset.path;
      if(target.checked)S.selectedPaths.add(filePath);
      else S.selectedPaths.delete(filePath);
      updateFileSelection(filePath);
    }else{
      const allPaths=S.files.map(file=>U.fPath(file));
      if(target.checked)allPaths.forEach(path=>S.selectedPaths.add(path));
      else allPaths.forEach(path=>S.selectedPaths.delete(path));
      allPaths.forEach(updateFileSelection);
    }
    updateSelectAllCheckbox();
    updateBatchDeleteButton();
  }

  // ============================================================
  //  初始化
  // ============================================================
  async function init() {
    Toast.init();
    await AuthUI.ensureAuthenticated();

    // 全局事件委托
    document.addEventListener('click', handleAction);
    document.addEventListener('change',handleFileSelectionChange);

    // 文件列表：双击目录行进入
    qs('#files-body').addEventListener('dblclick', e => {
      const row = e.target.closest('[data-type="directory"]');
      if (!row) return;
      e.preventDefault();
      S.dir = row.dataset.path;
      S.selectedPaths.clear();
      updateRoute('files', 'push');
      loadFiles(row.dataset.path);
    });

    // 侧边栏导航
    qsa('.nav-item').forEach(el => {
      el.addEventListener('click', event => {
        event.preventDefault();
        nav(el.dataset.page);
      });
    });

    window.addEventListener('popstate', () => {
      const route = readRoute();
      S.dir = route.directory;
      nav(route.page, { history:'none' });
    });

    // 移动端侧边栏
    qs('#sidebar-toggle').addEventListener('click', () => {
      qs('#nav-sidebar').classList.toggle('open');
      qs('#sidebar-backdrop').classList.toggle('show');
    });
    qs('#sidebar-backdrop').addEventListener('click', () => {
      qs('#nav-sidebar').classList.remove('open');
      qs('#sidebar-backdrop').classList.remove('show');
    });

    // 视图切换
    qsa('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        qsa('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S.viewMode = btn.dataset.view;
        if (S.files.length > 0) renderFileList(S.files);
      });
    });

    // 搜索
    qs('#global-search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (S.page !== 'files') nav('files', { load: false });
        doSearch(e.target.value.trim());
      }, 500);
    });

    // 右键菜单
    document.addEventListener('contextmenu', e => {
      const fileEl = e.target.closest('[data-path]');
      if (fileEl) {
        showContextMenu(e, fileEl.dataset.path);
      } else {
        hideContextMenu();
      }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.context-menu')) hideContextMenu();
    });

    // 模态框遮罩关闭
    qs('#modal-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });

    // 上传初始化
    initUpload();

    // 直接访问任意功能路径时恢复对应页面；文件页仍优先完成首屏加载。
    const initialRoute = readRoute();
    S.dir = initialRoute.directory;
    nav(initialRoute.page, { load:false, history:'replace' });
    if (initialRoute.page === 'files') await loadFiles();
    else nav(initialRoute.page, { history:'none' });
    warmDirectoryCache();
    checkConnection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { navigateTo: nav, loadFiles, closeModal, clearUploadQueue };
})();
