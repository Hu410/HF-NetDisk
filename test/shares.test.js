import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareStore } from '../src/durableObjects/shareStore.js';
import { HuggingFaceAPI } from '../src/huggingfaceAPI.js';
import { sharesHandler } from '../src/routes/shares.js';

class MemoryStorage {
  constructor(){ this.values=new Map(); }
  async get(key){ return this.values.get(key); }
  async put(key,value){ this.values.set(key,value); }
  async delete(key){ return this.values.delete(key); }
  async list({prefix='' }={}){ return new Map([...this.values].filter(([key])=>key.startsWith(prefix))); }
}

function environment(){
  const store=new ShareStore({ storage:new MemoryStorage() });
  return {
    HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',
    SESSIONS:{ idFromName:()=>1,get:()=>({ fetch:async()=>Response.json({valid:true}) }) },
    SHARES:{ idFromName:()=>1,get:()=>({ fetch:(input,init)=>store.fetch(new Request(input,init)) }) },
  };
}

function managed(url,env,method='GET',body){
  return sharesHandler({ request:new Request(url,{ method,headers:{ Cookie:'hf_session=x','Content-Type':'application/json' },body:body?JSON.stringify(body):undefined }),env });
}

afterEach(()=>vi.restoreAllMocks());

describe('shares',()=>{
  it('rejects an ID collision without replacing the existing share',async()=>{
    const store=new ShareStore({ storage:new MemoryStorage() });
    const id='aB3dE5g7';
    const first={ id,path:'first.txt',name:'first.txt',type:'file',createdAt:'2026-09-01T00:00:00Z',expiresAt:null };
    const second={ ...first,path:'second.txt',name:'second.txt' };
    expect((await store.fetch(new Request('https://shares/share/create',{method:'POST',body:JSON.stringify(first)}))).status).toBe(200);
    const collision=await store.fetch(new Request('https://shares/share/create',{method:'POST',body:JSON.stringify(second)}));
    expect(collision.status).toBe(409);
    expect((await collision.json()).code).toBe('SHARE_ID_COLLISION');
    const stored=await store.fetch(new Request('https://shares/share/get',{method:'POST',body:JSON.stringify({id})}));
    expect((await stored.json()).share.path).toBe('first.txt');
  });

  it('creates a password-protected share without exposing password material and unlocks it',async()=>{
    const env=environment();
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({
      files:[{path:'folder/中文.txt',name:'中文.txt',size:12}],directories:[],nextCursor:null,
    });
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockResolvedValue(new Response(null,{status:200,headers:{'Content-Length':'12'}}));
    const created=await managed('https://disk.test/api/shares',env,'POST',{path:'folder/中文.txt',type:'file',expiresIn:3600,password:'secret'});
    expect(created.status).toBe(201);
    const createdBody=await created.json();
    expect(createdBody.share.passwordProtected).toBe(true);
    expect(JSON.stringify(createdBody)).not.toContain('passwordHash');
    expect(JSON.stringify(createdBody)).not.toContain('secret');
    const id=createdBody.share.id;
    expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(createdBody.share.url).toBe(`https://disk.test/s/${id}`);

    const locked=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}`),env});
    expect((await locked.json()).share.locked).toBe(true);

    const denied=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})}),env});
    expect(denied.status).toBe(401);

    const unlocked=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'secret'})}),env});
    expect(unlocked.status).toBe(200);
    const cookie=unlocked.headers.get('Set-Cookie').split(';')[0];
    expect(unlocked.headers.get('Set-Cookie')).toContain('HttpOnly');

    const info=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}`,{headers:{Cookie:cookie}}),env});
    const infoBody=await info.json();
    expect(infoBody.share.locked).toBe(false);
    expect(infoBody.share.size).toBe(12);

    const listed=await managed('https://disk.test/api/shares',env);
    expect((await listed.json()).shares).toHaveLength(1);
    const revoked=await managed(`https://disk.test/api/shares/${id}`,env,'DELETE');
    expect(revoked.status).toBe(200);
    const missing=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}`),env});
    expect(missing.status).toBe(404);
  });

  it('prevents a folder share download from escaping its directory',async()=>{
    const env=environment();
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({
      files:[],directories:[{path:'shared',name:'shared'}],nextCursor:null,
    });
    const created=await managed('https://disk.test/api/shares',env,'POST',{path:'shared',type:'directory',expiresIn:3600,password:''});
    const id=(await created.json()).share.id;
    const response=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}/download?file=${encodeURIComponent('../private.txt')}`),env});
    expect(response.status).toBe(400);
  });

  it('loads a public folder share with the server-recursive paged tree',async()=>{
    const env=environment(),id='cD4eF6g8';
    await env.SHARES.get().fetch('https://shares/share/create',{method:'POST',body:JSON.stringify({
      id,path:'shared',name:'shared',type:'directory',createdAt:'2026-09-01T00:00:00Z',expiresAt:null,passwordHash:null,passwordSalt:null,
    })});
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({
      files:[{path:'shared/docs/report.pdf',name:'report.pdf',size:20,lastModified:'2026-09-01T00:00:00Z'}],
      directories:[{path:'shared/docs',name:'docs'}],
    });
    const response=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}`),env});
    const body=await response.json();
    expect(body.share.files.map(file=>file.path)).toEqual(['docs/report.pdf']);
    expect(body.share.directories).toEqual(['docs']);
    expect(list).toHaveBeenCalledWith('shared',true,{serverRecursive:true});
  });

  it('rejects an expired share',async()=>{
    const env=environment(),id='b'.repeat(32);
    await env.SHARES.get().fetch('https://shares/share/create',{method:'POST',body:JSON.stringify({
      id,path:'old.txt',name:'old.txt',type:'file',createdAt:'2025-01-01T00:00:00Z',expiresAt:'2025-01-02T00:00:00Z',passwordHash:null,passwordSalt:null,
    })});
    const response=await sharesHandler({request:new Request(`https://disk.test/api/public/shares/${id}`),env});
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('SHARE_EXPIRED');
  });

  it('returns managed shares in fixed pages of 20',async()=>{
    const env=environment();
    for(let index=0;index<25;index++){
      await env.SHARES.get().fetch('https://shares/share/create',{method:'POST',body:JSON.stringify({
        id:index.toString(36).padStart(8,'0'),path:`file-${index}.txt`,name:`file-${index}.txt`,type:'file',
        createdAt:new Date(Date.UTC(2026,0,index+1)).toISOString(),expiresAt:null,passwordHash:null,passwordSalt:null,
      })});
    }
    const firstBody=await (await managed('https://disk.test/api/shares?page=1',env)).json();
    const secondBody=await (await managed('https://disk.test/api/shares?page=2',env)).json();
    expect(firstBody.shares).toHaveLength(20);
    expect(firstBody.shares[0].name).toBe('file-24.txt');
    expect(secondBody.shares).toHaveLength(5);
    expect(secondBody.pagination).toEqual({page:2,limit:20,totalShares:25,totalPages:2});
  });
});
