/**
 * HuggingFace Hub API 封装类
 * 手动实现 LFS 上传协议（Cloudflare Workers 兼容）
 *
 * LFS 上传流程:
 * 1. preupload - 检查文件是否需要 LFS
 * 2. lfsBatch  - 获取 LFS 上传 URL
 * 3. upload    - 上传到 LFS S3 存储
 * 4. commit    - 提交 LFS 文件引用
 *
 * 小文件（< 20MB）可通过 Worker 代理上传
 * 大文件（>= 20MB）建议前端直传 S3，Worker 只负责签名和提交
 */

import { getFileSample, encodeRepoPath, encodeFilePath } from './utils/helpers.js';

export class HuggingFaceAPI {
  /**
   * @param {string} token  - HuggingFace Access Token
   * @param {string} repo   - 仓库名称 (username/repo-name)
   * @param {boolean} [isPrivate=false] - 是否为私有仓库
   */
  constructor(token, repo, isPrivate = false, config = {}) {
    this.token = token;
    this.repo = repo;
    this.isPrivate = isPrivate;
    this.baseURL = 'https://huggingface.co';
    this.encodedRepo = encodeRepoPath(repo);
    this.mirrorURL = resolveMirrorURL(config.HF_MIRROR_URL, config.HF_MIRROR_ALLOWED_HOSTS);
  }

  /* ======================== 认证头构建 ======================== */

  _authHeaders() {
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /* ======================== 仓库操作 ======================== */

  /**
   * 检查仓库是否存在
   * @returns {Promise<boolean>}
   */
  async repoExists() {
    try {
      const response = await fetch(`${this.baseURL}/api/datasets/${this.encodedRepo}`, {
        headers: this._authHeaders(),
      });
      return response.ok;
    } catch (error) {
      console.error('Error checking repo:', error.message);
      return false;
    }
  }

  /**
   * 创建数据集仓库（如果不存在）
   * @returns {Promise<boolean>}
   */
  async createRepoIfNotExists() {
    try {
      if (await this.repoExists()) {
        return true;
      }

      const repoName = this.repo.split('/')[1];
      const response = await fetch(`${this.baseURL}/api/repos/create`, {
        method: 'POST',
        headers: {
          ...this._authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          type: 'dataset',
          private: this.isPrivate,
        }),
      });

      if (response.ok || response.status === 409) {
        return true;
      }

      const errorText = await response.text();
      throw new Error(`Failed to create repo: ${response.status} - ${errorText}`);
    } catch (error) {
      console.error('Error creating repo:', error.message);
      return false;
    }
  }

  /**
   * 获取仓库详细信息
   * @returns {Promise<object|null>} 仓库信息或 null
   */
  async getRepoInfo() {
    const response = await fetch(`${this.baseURL}/api/datasets/${this.encodedRepo}`, {
      headers: this._authHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get repo info: ${response.status}`);
    }

    return await response.json();
  }

  /* ======================== 目录操作 ======================== */

  /**
   * 列出目录内容
   * 使用 HuggingFace Hub API 获取目录树
   * @param {string} [dirPath=''] - 目录路径（空 = 根目录）
   * @param {boolean} [recursive=false] - 是否递归列出所有子目录
   * @returns {Promise<{files: Array, directories: Array}>}
   */
  async listDirectory(dirPath = '', recursive = false, options = {}) {
    // 规范化路径
    const normalizedPath = dirPath.replace(/^\/+|\/+$/g, '');
    const rawUrl = normalizedPath
      ? `${this.baseURL}/api/datasets/${this.encodedRepo}/tree/main/${encodeFilePath(normalizedPath)}`
      : `${this.baseURL}/api/datasets/${this.encodedRepo}/tree/main`;
    const url = new URL(rawUrl);
    if (recursive && options.serverRecursive) url.searchParams.set('recursive', 'true');
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    if (options.cursor) url.searchParams.set('cursor', options.cursor);
    if (options.expand) url.searchParams.set('expand', 'true');

    const response = await fetch(url.toString(), {
      headers: this._authHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { files: [], directories: [] };
      }
      throw new Error(`Failed to list directory: ${response.status} - ${await response.text()}`);
    }

    const items = await response.json();
    const result = await this._parseTreeItems(items, normalizedPath, recursive && !options.serverRecursive, options);
    result.nextCursor = getNextCursor(response.headers.get('Link'));
    return result;
  }

  async listDirectoryAllPages(dirPath = '', recursive = false, options = {}) {
    const files = [];
    const directories = [];
    let cursor = null;
    do {
      const page = await this.listDirectory(dirPath, recursive, { ...options, cursor });
      files.push(...page.files);
      directories.push(...page.directories);
      cursor = page.nextCursor || null;
    } while (cursor);
    return { files, directories };
  }

  /**
   * 解析目录树返回数据
   * @private
   */
  async _parseTreeItems(items, basePath, recursive, options = {}) {
    const files = [];
    const directories = [];

    if (!Array.isArray(items)) return { files, directories };

    for (const item of items) {
      if (item.type === 'directory') {
        const dirPath = item.path;
        const dirName = dirPath.includes('/') ? dirPath.substring(dirPath.lastIndexOf('/') + 1) : dirPath;
        directories.push({
          name: dirName,
          path: dirPath,
          type: 'directory',
          size: item.size || 0,
          lastModified: item.lastCommit?.date || item.lastModified || null,
        });
        // 递归列出子目录
        if (recursive) {
          const sub = await this.listDirectory(dirPath, true, options.expand ? { expand:true } : {});
          files.push(...sub.files);
          directories.push(...sub.directories);
        }
      } else if (item.type === 'file') {
        files.push({
          name: item.path.replace(basePath ? basePath + '/' : '', ''),
          path: item.path,
          type: 'file',
          size: item.size || 0,
          oid: item.oid || '',
          lastModified: item.lastCommit?.date || item.lastModified || null,
          lastCommit: item.lastCommit || null,
          blobId: item.blobId || '',
          lfs: item.lfs || null,
        });
      }
    }

    return { files, directories };
  }

  /**
   * 获取仓库完整文件树（递归）
   * @returns {Promise<{files: Array, directories: Array}>}
   */
  async listAllFiles() {
    return await this.listDirectory('', true);
  }

  /* ======================== LFS 上传协议 ======================== */

  /**
   * 步骤1: Preupload - 检查文件是否需要 LFS
   * @param {string} filePath - 文件路径
   * @param {number} fileSize - 文件大小（字节）
   * @param {string} fileSample - 文件前512字节的 base64
   * @returns {Promise<object>}
   */
  async preupload(filePath, fileSize, fileSample) {
    const url = `${this.baseURL}/api/datasets/${this.encodedRepo}/preupload/main`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{
          path: filePath,
          size: fileSize,
          sample: fileSample,
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Preupload failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * 步骤2: LFS Batch - 获取上传 URL
   * @param {string} oid - 文件的 SHA256 哈希
   * @param {number} fileSize - 文件大小
   * @returns {Promise<object>}
   */
  async lfsBatch(oid, fileSize) {
    const url = `${this.baseURL}/datasets/${this.encodedRepo}.git/info/lfs/objects/batch`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._authHeaders(),
        'Accept': 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({
        operation: 'upload',
        transfers: ['basic', 'multipart'],
        hash_algo: 'sha_256',
        ref: { name: 'main' },
        objects: [{ oid, size: fileSize }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LFS batch failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * 步骤3: 上传文件到 LFS 存储
   * @param {object} uploadAction - 上传动作信息 { href, header }
   * @param {Blob|File} file - 文件数据
   * @param {string} oid - 文件 SHA256 哈希
   * @returns {Promise<boolean>}
   */
  async uploadToLFS(uploadAction, file, oid) {
    const { href, header } = uploadAction;

    // 分片上传
    if (header?.chunk_size) {
      return await this._uploadMultipart(uploadAction, file, oid);
    }

    // 基本上传
    const response = await fetch(href, {
      method: 'PUT',
      headers: header || {},
      body: file,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LFS upload failed: ${response.status} - ${error}`);
    }

    return true;
  }

  /**
   * 分片上传（大文件）
   * @private
   */
  async _uploadMultipart(uploadAction, file, oid) {
    const { href: completionUrl, header } = uploadAction;
    const chunkSize = parseInt(header.chunk_size);

    const parts = Object.keys(header).filter(key => /^[0-9]+$/.test(key));
    const completeParts = [];

    for (const part of parts) {
      const index = parseInt(part) - 1;
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);

      const response = await fetch(header[part], {
        method: 'PUT',
        body: chunk,
      });

      if (!response.ok) {
        throw new Error(`Failed to upload part ${part}: ${response.status}`);
      }

      const etag = response.headers.get('ETag');
      if (!etag) {
        throw new Error(`No ETag for part ${part}`);
      }

      completeParts.push({ partNumber: parseInt(part), etag });
    }

    // 完成分片上传
    const completeResponse = await fetch(completionUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({
        oid,
        parts: completeParts,
      }),
    });

    if (!completeResponse.ok) {
      const error = await completeResponse.text();
      throw new Error(`Multipart complete failed: ${completeResponse.status} - ${error}`);
    }

    return true;
  }

  /**
   * 步骤4: 提交 LFS 文件引用
   * @param {string} filePath - 文件路径
   * @param {string} oid - SHA256 哈希
   * @param {number} fileSize - 文件大小
   * @param {string} commitMessage - 提交信息
   * @returns {Promise<object>}
   */
  async commitLfsFile(filePath, oid, fileSize, commitMessage = 'Upload file via HF Netdisk') {
    const url = `${this.baseURL}/api/datasets/${this.encodedRepo}/commit/main`;

    const body = this._buildNDJson(commitMessage, 'lfsFile', {
      path: filePath,
      algo: 'sha256',
      size: fileSize,
      oid,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._authHeaders(),
        'Content-Type': 'application/x-ndjson',
      },
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Commit failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /* ======================== 完整上传流程 ======================== */

  /**
   * 上传文件（完整流程）
   * 适用于小文件或需要代理上传的场景
   * @param {Blob|File} file - 文件
   * @param {string} filePath - 存储路径
   * @param {string} [commitMessage='Upload file via HF Netdisk'] - 提交信息
   * @param {string|null} [precomputedSha256=null] - 前端预计算的 SHA256
   * @returns {Promise<object>} { success, filePath, fileUrl, fileSize, oid }
   */
  async uploadFile(file, filePath, commitMessage = 'Upload file via HF Netdisk', precomputedSha256 = null) {
    if (!await this.createRepoIfNotExists()) {
      throw new Error('Failed to create or access repository');
    }

    // 1. 计算 SHA256
    let oid;
    if (precomputedSha256) {
      oid = precomputedSha256;
    } else {
      oid = await this._computeSha256(file);
    }

    // 2. 获取文件样本
    const sample = await getFileSample(file, 512);

    // 3. Preupload 检查
    const preuploadResult = await this.preupload(filePath, file.size, sample);
    const fileInfo = preuploadResult.files?.[0];
    const needsLfs = fileInfo?.uploadMode === 'lfs';

    if (needsLfs) {
      // 4. LFS Batch
      const batchResult = await this.lfsBatch(oid, file.size);
      const obj = batchResult.objects?.[0];
      if (obj?.error) {
        throw new Error(`LFS error: ${obj.error.message}`);
      }

      // 5. 上传到 LFS
      if (obj?.actions?.upload) {
        await this.uploadToLFS(obj.actions.upload, file, oid);
      }

      // 6. 提交 LFS 引用
      await this.commitLfsFile(filePath, oid, file.size, commitMessage);
    } else {
      // 非 LFS 文件：直接 base64 提交
      await this._commitDirectFile(filePath, file, commitMessage);
    }

    const fileUrl = `${this.baseURL}/datasets/${this.encodedRepo}/resolve/main/${encodeFilePath(filePath)}`;
    return {
      success: true,
      filePath,
      fileUrl,
      fileSize: file.size,
      oid,
    };
  }

  /**
   * 获取 LFS 上传信息（用于前端直传大文件）
   * @param {number} fileSize - 文件大小
   * @param {string} filePath - 存储路径
   * @param {string} sha256 - 文件 SHA256 哈希
   * @param {string} fileSample - 文件前512字节 base64
   * @returns {Promise<object>}
   */
  async getLfsUploadInfo(fileSize, filePath, sha256, fileSample) {
    if (!await this.createRepoIfNotExists()) {
      throw new Error('Failed to create or access repository');
    }

    const preuploadResult = await this.preupload(filePath, fileSize, fileSample);
    const fileInfo = preuploadResult.files?.[0];
    const needsLfs = fileInfo?.uploadMode === 'lfs';

    if (!needsLfs) {
      return { needsLfs: false };
    }

    const batchResult = await this.lfsBatch(sha256, fileSize);
    const obj = batchResult.objects?.[0];
    if (obj?.error) {
      throw new Error(`LFS error: ${obj.error.message}`);
    }

    if (!obj?.actions?.upload) {
      return {
        needsLfs: true,
        alreadyExists: true,
        oid: sha256,
        filePath,
      };
    }

    return {
      needsLfs: true,
      alreadyExists: false,
      oid: sha256,
      filePath,
      uploadAction: obj.actions.upload,
    };
  }

  /* ======================== 文件操作 ======================== */

  /**
   * 重命名文件
   * 通过 HuggingFace Commit API 的 JSON 格式完成重命名
   * @param {string} oldPath - 原路径
   * @param {string} newPath - 新路径
   * @param {string} [commitMessage] - 提交信息
   * @returns {Promise<boolean>}
   */
  async renameFile(oldPath, newPath, commitMessage = 'Rename file') {
    return this.moveFileAtomic(oldPath, newPath, commitMessage);
  }

  async listDirectoryRecursive(dirPath = '') {
    const files = [];
    const directories = [];
    const queue = [dirPath.replace(/^\/+|\/+$/g, '')];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      let cursor = null;
      do {
        const page = await this.listDirectory(current, false, { limit: 100, cursor });
        files.push(...page.files);
        for (const directory of page.directories) {
          directories.push(directory);
          queue.push(directory.path);
        }
        cursor = page.nextCursor || null;
      } while (cursor);
    }
    return { files, directories };
  }

  async moveFileAtomic(oldPath, newPath, commitMessage = 'Move file via HF Netdisk', extraOperations = []) {
    const operations = await this._buildMoveOperations(oldPath, newPath);
    operations.push(...extraOperations);
    await this.commitOperations(commitMessage, operations);
    return true;
  }

  async moveDirectoryAtomic(oldPath, newPath, commitMessage = 'Move directory via HF Netdisk', extraOperations = []) {
    const source = oldPath.replace(/\/+$/, '');
    const target = newPath.replace(/\/+$/, '');
    const tree = await this.listDirectoryRecursive(source);
    if (!tree.files.length) throw new Error('Source directory is empty or not found');
    const operations = [];
    for (const file of tree.files) {
      const relativePath = file.path.slice(source.length).replace(/^\/+/, '');
      operations.push(...await this._buildMoveOperations(file.path, `${target}/${relativePath}`, file));
    }
    operations.push(...extraOperations);
    await this.commitOperations(commitMessage, operations);
    return { fileCount: tree.files.length };
  }

  async deleteDirectoryAtomic(path, commitMessage = 'Delete directory via HF Netdisk', extraOperations = []) {
    const source = path.replace(/\/+$/, '');
    const tree = await this.listDirectoryRecursive(source);
    const operations = tree.files.map(file => ({ key: 'deletedFile', value: { path: file.path } }));
    operations.push(...extraOperations);
    if (!operations.length) throw new Error('Directory is empty or not found');
    await this.commitOperations(commitMessage, operations);
    return { fileCount: tree.files.length };
  }

  async _buildMoveOperations(oldPath, newPath, knownFile = null) {
    let info = knownFile ? {
      size: Number(knownFile.size || 0),
      lfsOid: knownFile.lfs?.oid || '',
    } : await this._getFileInfo(oldPath);
    if (knownFile && info.size > 10 * 1024 * 1024 && !info.lfsOid) info = await this._getFileInfo(oldPath);
    if (!info) throw new Error('Source file not found');
    const operations = [];
    if (info.lfsOid) {
      operations.push({ key: 'lfsFile', value: { path: newPath, algo: 'sha256', size: info.size, oid: info.lfsOid } });
    } else {
      if (info.size > 10 * 1024 * 1024) throw new Error(`Unable to resolve LFS oid safely for ${oldPath}`);
      const response = await this.getFileContent(oldPath);
      if (!response.ok) throw new Error(`Failed to read source file: ${response.status}`);
      const content = arrayBufferToBase64(await response.arrayBuffer());
      operations.push({ key: 'file', value: { path: newPath, content, encoding: 'base64' } });
    }
    operations.push({ key: 'deletedFile', value: { path: oldPath } });
    return operations;
  }

  async commitOperations(summary, operations) {
    const url = `${this.baseURL}/api/datasets/${this.encodedRepo}/commit/main`;
    const body = [JSON.stringify({ key: 'header', value: { summary } }), ...operations.map(operation => JSON.stringify(operation))].join('\n');
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/x-ndjson' },
      body,
    });
    if (!response.ok) throw new Error(`Commit failed: ${response.status} - ${await response.text()}`);
    return response.json();
  }

  /**
   * 获取文件内容（代理读取）
   * @param {string} filePath - 文件路径
   * @param {boolean} [useMirror=false] - 是否优先使用镜像源下载
   * @returns {Promise<Response>} - fetch Response
   */
  async getFileContent(filePath, useMirror = false, requestHeaders = null, method = 'GET') {
    const headers = {};
    if (this.isPrivate && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (requestHeaders) {
      for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
        const value = requestHeaders.get(name);
        if (value) headers[name] = value;
      }
    }

    // Never send private-repository credentials to a third-party mirror.
    if (useMirror && !this.isPrivate && this.mirrorURL) {
      // 镜像优先：尝试两种路径格式
      const mirrorUrls = [
        `${this.mirrorURL}/datasets/${this.encodedRepo}/resolve/main/${encodeFilePath(filePath)}`,
        `${this.mirrorURL}/${this.encodedRepo}/resolve/main/${encodeFilePath(filePath)}`,
      ];
      for (const url of mirrorUrls) {
        try {
          const res = await fetch(url, { headers, method });
          if (res.ok || res.status === 206) return res;
        } catch { /* 镜像不可达，尝试下一个 */ }
      }
      // 镜像全部失败，回退到官方
      console.log('Mirror failed, falling back to official URL');
    }

    const fileUrl = `${this.baseURL}/datasets/${this.encodedRepo}/resolve/main/${encodeFilePath(filePath)}`;
    return await fetch(fileUrl, { headers, method });
  }

  /**
   * 获取文件公开 URL
   * @param {string} filePath - 文件路径
   * @returns {string}
   */
  getFileURL(filePath) {
    const baseURL = !this.isPrivate && this.mirrorURL ? this.mirrorURL : this.baseURL;
    return `${baseURL}/datasets/${this.encodedRepo}/resolve/main/${encodeFilePath(filePath)}`;
  }

  /**
   * 获取文件原始信息（通过 API）
   * @private
   * @param {string} filePath - 文件路径
   * @returns {Promise<{oid: string, size: number, lfs: boolean}|null>}
   */
  async _getFileInfo(filePath) {
    try {
      const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
      const fileName = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
      const result = await this.listDirectory(parentDir);
      const file = result.files.find(f => f.path === filePath || f.name === fileName);
      if (file) {
        let lfsOid = file.lfs?.oid || '';
        if (!lfsOid && file.size > 10 * 1024 * 1024) {
          const head = await this.getFileContent(filePath, false, null, 'HEAD');
          const etag = (head.headers.get('ETag') || '').replace(/^W\//, '').replaceAll('"', '');
          if (/^[a-f0-9]{64}$/i.test(etag)) lfsOid = etag;
        }
        return {
          oid: file.oid || '',
          size: file.size || 0,
          lfs: Boolean(lfsOid),
          lfsOid,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /* ======================== 直接提交文件 ======================== */

  /**
   * 直接提交文件（非 LFS，用于小文件）
   * @private
   */
  async _commitDirectFile(filePath, file, commitMessage) {
    const url = `${this.baseURL}/api/datasets/${this.encodedRepo}/commit/main`;

    const content = arrayBufferToBase64(await file.arrayBuffer());

    const body = this._buildNDJson(commitMessage, 'file', {
      path: filePath,
      content,
      encoding: 'base64',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._authHeaders(),
        'Content-Type': 'application/x-ndjson',
      },
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Direct commit failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /* ======================== 工具方法 ======================== */

  /**
   * 构建 NDJSON 格式的 commit body
   * @private
   * @param {string} summary - 提交摘要
   * @param {string} key - 数据键名（如 'lfsFile', 'deletedFile', 'file'）
   * @param {object} value - 数据值
   * @returns {string} NDJSON 格式字符串
   */
  _buildNDJson(summary, key, value) {
    return [
      JSON.stringify({ key: 'header', value: { summary } }),
      JSON.stringify({ key, value }),
    ].join('\n');
  }

  /**
   * 计算文件 SHA256
   * @private
   */
  async _computeSha256(blob) {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 从 metadata 中提取文件大小
   * @param {object} metadata
   * @returns {number|null}
   */
  static getMetadataFileSize(metadata = {}) {
    const fileSizeBytes = Number(metadata?.FileSizeBytes);
    if (Number.isFinite(fileSizeBytes) && fileSizeBytes > 0) {
      return Math.floor(fileSizeBytes);
    }
    const fileSizeMB = Number(metadata?.FileSize);
    if (Number.isFinite(fileSizeMB) && fileSizeMB > 0) {
      return Math.floor(fileSizeMB * 1024 * 1024);
    }
    return null;
  }
}

function resolveMirrorURL(rawURL, rawAllowedHosts) {
  if (!rawURL) return null;
  try {
    const url = new URL(rawURL);
    const allowedHosts = String(rawAllowedHosts || '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean);
    if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 4096, bytes.length))));
  }
  return btoa(parts.join(''));
}

function getNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="?next"?/i);
  if (!match) return null;
  try { return new URL(match[1]).searchParams.get('cursor'); } catch { return null; }
}
