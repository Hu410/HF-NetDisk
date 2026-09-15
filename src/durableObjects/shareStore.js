import { hashShareToken, verifyPassword } from '../utils/shareCrypto.js';
import { randomHex } from '../utils/helpers.js';

const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

export class ShareStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    switch (url.pathname) {
      case '/share/create': return this.create(body);
      case '/share/list': return this.list(body);
      case '/share/get': return this.get(body.id);
      case '/share/delete': return this.remove(body.id);
      case '/share/unlock': return this.unlock(body);
      case '/grant/verify': return this.verifyGrant(body);
      default: return Response.json({ error:'Not found' }, { status:404 });
    }
  }

  async create(record) {
    const existing = await this.state.storage.list({ prefix:'share:' });
    if (existing.size >= 1000) return Response.json({ error:'Share limit reached' }, { status:409 });
    if (!validId(record.id)) return Response.json({ error:'Invalid share ID' }, { status:400 });
    const key=`share:${record.id}`;
    if (await this.state.storage.get(key)) {
      return Response.json({ error:'Share ID collision',code:'SHARE_ID_COLLISION' }, { status:409 });
    }
    await this.state.storage.put(key, record);
    return Response.json({ share:publicRecord(record) });
  }

  async list({ page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeLimit = Math.min(20, Math.max(1, Number.parseInt(limit, 10) || 20));
    const entries = await this.state.storage.list({ prefix:'share:' });
    const allShares = Array.from(entries.values()).map(publicRecord)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const totalShares = allShares.length;
    const totalPages = Math.max(1, Math.ceil(totalShares / safeLimit));
    const currentPage = Math.min(safePage, totalPages);
    const start = (currentPage - 1) * safeLimit;
    return Response.json({
      shares:allShares.slice(start,start + safeLimit),
      pagination:{ page:currentPage,limit:safeLimit,totalShares,totalPages },
    });
  }

  async get(id) {
    const share = validId(id) ? await this.state.storage.get(`share:${id}`) : null;
    return share ? Response.json({ share }) : Response.json({ error:'Share not found' }, { status:404 });
  }

  async remove(id) {
    if (!validId(id)) return Response.json({ error:'Share not found' }, { status:404 });
    const existed = Boolean(await this.state.storage.get(`share:${id}`));
    await this.state.storage.delete(`share:${id}`);
    return Response.json({ success:true, existed });
  }

  async unlock({ id, password, clientKey = 'unknown' }) {
    const share = validId(id) ? await this.state.storage.get(`share:${id}`) : null;
    if (!share) return Response.json({ error:'Share not found' }, { status:404 });
    if (isExpired(share)) return Response.json({ error:'Share expired' }, { status:410 });
    const failureKey = `failure:${id}:${clientKey}`;
    const failure = await this.state.storage.get(failureKey);
    if (failure && failure.expiresAt > Date.now() && failure.count >= MAX_FAILURES) {
      return Response.json({ error:'Too many attempts', retryAfter:Math.ceil((failure.expiresAt-Date.now())/1000) }, { status:429 });
    }
    if (!await verifyPassword(String(password || ''), share.passwordSalt, share.passwordHash)) {
      const expiresAt = failure?.expiresAt > Date.now() ? failure.expiresAt : Date.now()+FAILURE_WINDOW_MS;
      await this.state.storage.put(failureKey,{ count:(failure?.expiresAt>Date.now()?failure.count:0)+1, expiresAt },{ expirationTtl:Math.ceil((expiresAt-Date.now())/1000) });
      return Response.json({ error:'Incorrect password' }, { status:401 });
    }
    await this.state.storage.delete(failureKey);
    const token=randomHex(24);
    const expiresAt=Math.min(share.expiresAt ? Date.parse(share.expiresAt) : Infinity,Date.now()+ACCESS_TTL_MS);
    await this.state.storage.put(`grant:${id}:${await hashShareToken(token)}`,{ expiresAt },{ expirationTtl:Math.max(1,Math.ceil((expiresAt-Date.now())/1000)) });
    return Response.json({ token, expiresAt });
  }

  async verifyGrant({ id, token }) {
    if (!validId(id) || !token) return Response.json({ valid:false });
    const grant=await this.state.storage.get(`grant:${id}:${await hashShareToken(token)}`);
    return Response.json({ valid:Boolean(grant && grant.expiresAt>Date.now()) });
  }
}

function publicRecord(record) {
  const { passwordHash:_hash,passwordSalt:_salt,...share }=record;
  return { ...share, passwordProtected:Boolean(record.passwordHash), expired:isExpired(record) };
}

function isExpired(share) { return Boolean(share.expiresAt && Date.parse(share.expiresAt)<=Date.now()); }
function validId(id) { return /^(?:[A-Za-z0-9]{8}|[a-f0-9]{32})$/.test(id || ''); }
