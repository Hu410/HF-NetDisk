import { API } from '../api.js';
import { escapeHtml } from '../utils/format.js';

export function createTrashPage({ toast, cacheTtl = 0, onMutation = () => {} }) {
  let currentPage = 1;
  let totalPages = 1;
  let requestController = null;
  const pageCache = new Map();

  async function load(page = 1, { force = false } = {}) {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const body = document.querySelector('#trash-body');
    const emptyButton = document.querySelector('#empty-trash-btn');
    if (emptyButton) emptyButton.disabled = true;
    const cached = pageCache.get(page);
    let result = !force && cached && Date.now() - cached.createdAt < cacheTtl ? cached.value : null;
    if (!result) body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
    try {
      if (!result) {
        result = await API.listTrash(page, { signal:controller.signal });
        pageCache.set(page, { createdAt:Date.now(), value:result });
      }
      if (controller.signal.aborted) return;
      const { entries = [], pagination = {} } = result;
      currentPage = pagination.page || 1;
      totalPages = pagination.totalPages || 1;
      if (emptyButton) emptyButton.disabled = entries.length === 0;
      if (!entries.length) {
        body.innerHTML = '<div class="empty-state"><div class="empty-icon">🗑️</div><h3>回收站为空</h3></div>';
        return;
      }
      body.innerHTML = `<table class="file-table"><thead><tr><th>原路径</th><th>删除时间</th><th></th></tr></thead><tbody>${entries.map(entry => `<tr><td>${escapeHtml(entry.originalPath)}</td><td>${new Date(entry.deletedAt).toLocaleString('zh-CN')}</td><td><div class="file-actions"><button class="btn btn-sm btn-outline" data-action="trash-restore-${entry.batchId}">恢复</button><button class="btn btn-sm btn-danger" data-action="trash-purge-${entry.batchId}">彻底删除</button></div></td></tr>`).join('')}</tbody></table>
        <div class="recent-pagination" aria-label="回收站分页"><span>共 ${pagination.totalEntries || entries.length} 项</span><div>
          <button class="btn btn-sm btn-outline" data-action="trash-prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${currentPage} / ${totalPages} 页</span>
          <button class="btn btn-sm btn-outline" data-action="trash-next" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
        </div></div>`;
    } catch (error) {
      if (error.name === 'AbortError') return;
      body.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
      if (requestController === controller) requestController = null;
    }
  }

  async function restore(batchId) {
    try {
      await API.restoreTrash(batchId, 'reject');
    } catch (error) {
      if (error.code !== 'PATH_CONFLICT' && error.code !== 'FILE_EXISTS') throw error;
      if (window.confirm('原位置已有同名文件，是否覆盖？')) await API.restoreTrash(batchId, 'overwrite');
      else if (window.confirm('是否自动重命名后恢复？')) await API.restoreTrash(batchId, 'rename');
      else return;
    }
    invalidate();
    onMutation('restore');
    toast.success('文件已恢复');
    await load(currentPage, { force:true });
  }

  async function purge(batchId) {
    if (!window.confirm('彻底删除后无法从网盘回收站恢复，是否继续？')) return;
    await API.purgeTrash(batchId);
    invalidate();
    onMutation('purge');
    toast.success('已从回收站移除');
    await load(currentPage, { force:true });
  }

  async function empty() {
    const button = document.querySelector('#empty-trash-btn');
    if (button) { button.disabled = true; button.textContent = '清空中...'; }
    try {
      const result = await API.emptyTrash();
      invalidate();
      onMutation('empty');
      toast.success('回收站已清空', `已永久删除 ${result.deletedFiles || 0} 个存储文件`);
      await load(1, { force:true });
    } finally {
      if (button) button.textContent = '清空回收站';
    }
  }

  return {
    load,
    previous: () => load(Math.max(1, currentPage - 1)),
    next: () => load(Math.min(totalPages, currentPage + 1)),
    cancel: () => requestController?.abort(),
    invalidate,
    restore,
    purge,
    empty,
  };

  function invalidate() {
    pageCache.clear();
  }
}
