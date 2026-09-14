import { describe, expect, it } from 'vitest';
import { UploadSession } from '../src/durableObjects/uploadSession.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix='' }={}) { return new Map([...this.values].filter(([key])=>key.startsWith(prefix))); }
  async deleteAll() { this.values.clear(); }
  async setAlarm(value) { this.alarm = value; }
}

async function call(store, path, body) {
  const response = await store.fetch(new Request(`https://upload${path}`, { method:'POST', body:JSON.stringify(body) }));
  return { status:response.status, body:await response.json() };
}

describe('UploadSession', () => {
  it('binds targets and completion state to the session owner', async () => {
    const store = new UploadSession({ storage:new MemoryStorage() });
    const record = { ownerHash:'owner', mode:'multipart', filePath:'目录/文件.bin', fileSize:10, oid:'a'.repeat(64), chunkSize:6, partUrls:{ 1:'https://storage/1', 2:'https://storage/2' } };
    expect((await call(store,'/create',record)).status).toBe(200);
    expect((await call(store,'/target',{ownerHash:'other',partNumber:1})).status).toBe(403);
    const target = await call(store,'/target',{ownerHash:'owner',partNumber:2});
    expect(target.body).toMatchObject({ target:'https://storage/2', expectedSize:4 });
    await call(store,'/part',{ownerHash:'owner',partNumber:1,etag:'one'});
    expect((await call(store,'/complete',{ownerHash:'owner'})).status).toBe(409);
    await call(store,'/part',{ownerHash:'owner',partNumber:2,etag:'two'});
    expect((await call(store,'/complete',{ownerHash:'owner'})).body.parts).toHaveLength(2);
    expect((await call(store,'/ready',{ownerHash:'owner'})).status).toBe(200);
  });

  it('records concurrent part completions without overwriting another part',async()=>{
    const store=new UploadSession({storage:new MemoryStorage()});
    const record={ownerHash:'owner',mode:'multipart',filePath:'file.bin',fileSize:8,oid:'b'.repeat(64),chunkSize:2,partUrls:{1:'https://storage/1',2:'https://storage/2',3:'https://storage/3',4:'https://storage/4'}};
    await call(store,'/create',record);
    await Promise.all([1,2,3,4].map(partNumber=>call(store,'/part',{ownerHash:'owner',partNumber,etag:`etag-${partNumber}`})));
    const completed=await call(store,'/complete',{ownerHash:'owner'});
    expect(completed.status).toBe(200);
    expect(completed.body.parts).toEqual([
      {partNumber:1,etag:'etag-1'},{partNumber:2,etag:'etag-2'},{partNumber:3,etag:'etag-3'},{partNumber:4,etag:'etag-4'},
    ]);
  });
});
