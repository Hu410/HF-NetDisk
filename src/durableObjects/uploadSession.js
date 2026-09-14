const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

export class UploadSession {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const record = await this.state.storage.get('upload');

    if (url.pathname === '/create') {
      if (record) return Response.json({ error: 'Upload session already exists' }, { status: 409 });
      const created = { ...body, status: 'uploading', parts: {}, createdAt: Date.now(), expiresAt: Date.now() + UPLOAD_TTL_MS };
      await this.state.storage.put('upload', created);
      await this.state.storage.setAlarm(created.expiresAt);
      return Response.json({ success: true, expiresAt: created.expiresAt });
    }

    if (!record || record.expiresAt <= Date.now()) return Response.json({ error: 'Upload session expired' }, { status: 410 });
    if (record.ownerHash !== body.ownerHash) return Response.json({ error: 'Upload session access denied' }, { status: 403 });

    if (url.pathname === '/target') {
      if (record.status !== 'uploading') return Response.json({ error: 'Upload is not active' }, { status: 409 });
      const partNumber = Number(body.partNumber || 0);
      if (record.mode === 'multipart') {
        const target = record.partUrls?.[String(partNumber)];
        if (!target) return Response.json({ error: 'Invalid part number' }, { status: 400 });
        return Response.json({ target, headers: {}, expectedSize: expectedPartSize(record, partNumber), mode: record.mode });
      }
      if (partNumber !== 0) return Response.json({ error: 'Invalid part number' }, { status: 400 });
      return Response.json({ target: record.target, headers: record.uploadHeaders || {}, expectedSize: record.fileSize, mode: record.mode });
    }

    if (url.pathname === '/part') {
      await this.state.storage.put(`part:${body.partNumber}`, body.etag || '');
      return Response.json({ success: true });
    }

    if (url.pathname === '/complete') {
      const storedParts = await this.state.storage.list({ prefix:'part:' });
      const parts = { ...(record.parts || {}) };
      for (const [key, etag] of storedParts) parts[key.slice(5)] = etag;
      if (record.mode === 'multipart') {
        const required = Object.keys(record.partUrls || {});
        if (required.some(part => !(part in parts))) return Response.json({ error: 'Upload has missing parts' }, { status: 409 });
      }
      record.parts = parts;
      record.status = 'uploaded';
      await this.state.storage.put('upload', record);
      return Response.json(publicUploadState(record));
    }

    if (url.pathname === '/ready') {
      if (record.status !== 'uploaded') return Response.json({ error: 'Upload is not ready to commit' }, { status: 409 });
      return Response.json(publicUploadState(record));
    }

    if (url.pathname === '/committed') {
      if (record.status !== 'uploaded') return Response.json({ error: 'Upload is not ready to commit' }, { status: 409 });
      record.status = 'committed';
      await this.state.storage.put('upload', record);
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

function expectedPartSize(record, partNumber) {
  const start = (partNumber - 1) * record.chunkSize;
  return Math.max(0, Math.min(record.chunkSize, record.fileSize - start));
}

function publicUploadState(record) {
  return {
    mode: record.mode,
    completionUrl: record.completionUrl || null,
    oid: record.oid,
    fileSize: record.fileSize,
    filePath: record.filePath,
    parts: Object.entries(record.parts).map(([partNumber, etag]) => ({ partNumber: Number(partNumber), etag })).sort((a, b) => a.partNumber - b.partNumber),
  };
}
