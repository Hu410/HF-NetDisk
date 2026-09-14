import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuggingFaceAPI } from '../src/huggingfaceAPI.js';
import { filesHandler } from '../src/routes/files.js';
import { trashHandler } from '../src/routes/trash.js';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('atomic moves',()=>{
  it('reuses an LFS oid and deletes the source in one NDJSON commit',async()=>{
    const api=new HuggingFaceAPI('token','owner/repo',true,{});
    vi.spyOn(api,'listDirectory').mockResolvedValue({files:[{path:'old.bin',name:'old.bin',size:12,lfs:{oid:'a'.repeat(64)}}],directories:[]});
    let request;
    vi.stubGlobal('fetch',async(url,init)=>{request={url,init};return Response.json({ok:true});});
    await api.moveFileAtomic('old.bin','folder/new.bin','Move file');
    const lines=request.init.body.split('\n').map(JSON.parse);
    expect(lines[1]).toEqual({key:'lfsFile',value:{path:'folder/new.bin',algo:'sha256',size:12,oid:'a'.repeat(64)}});
    expect(lines[2]).toEqual({key:'deletedFile',value:{path:'old.bin'}});
  });

  it('moves deletes into a hidden trash batch with metadata',async()=>{
    const move=vi.spyOn(HuggingFaceAPI.prototype,'moveFileAtomic').mockResolvedValue(true);
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/files/folder%2Ffile.txt',{method:'DELETE',headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env});
    expect(response.status).toBe(200);
    const [,trashPath,,operations]=move.mock.calls[0];
    expect(trashPath).toMatch(/^\.trash\/[a-f0-9-]+\/folder\/file\.txt$/);
    expect(operations[0].value.path).toMatch(/\/\.metadata\.json$/);
  });

  it('moves every file in a directory into one trash batch',async()=>{
    const move=vi.spyOn(HuggingFaceAPI.prototype,'moveDirectoryAtomic').mockResolvedValue({fileCount:2});
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/files/folder?type=directory',{method:'DELETE',headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env});
    const body=await response.json();
    expect(response.status).toBe(200);
    expect(body.type).toBe('directory');
    expect(body.fileCount).toBe(2);
    expect(move.mock.calls[0][0]).toBe('folder');
    expect(move.mock.calls[0][1]).toMatch(/^\.trash\/[a-f0-9-]+\/folder$/);
  });

  it('restores a directory trash entry recursively',async()=>{
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockResolvedValue(Response.json({
      batchId:'a'.repeat(20),originalPath:'folder',trashPath:`.trash/${'a'.repeat(20)}/folder`,type:'directory',
    }));
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({files:[],directories:[]});
    const move=vi.spyOn(HuggingFaceAPI.prototype,'moveDirectoryAtomic').mockResolvedValue({fileCount:2});
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/trash/restore',{method:'POST',headers:{Cookie:'hf_session=x','Content-Type':'application/json'},body:JSON.stringify({batchId:'a'.repeat(20)})});
    const response=await trashHandler({request,env});
    const body=await response.json();
    expect(response.status).toBe(200);
    expect(body.type).toBe('directory');
    expect(body.fileCount).toBe(2);
    expect(move).toHaveBeenCalled();
  });

  it('loads trash metadata with a native recursive listing and bounded concurrency',async()=>{
    const files=Array.from({length:25},(_,index)=>({path:`.trash/batch-${index}/.metadata.json`,lastModified:new Date(Date.UTC(2026,7,index+1)).toISOString()}));
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({files,directories:[]});
    let active=0,maxActive=0;
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockImplementation(async path=>{
      active++;
      maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,2));
      active--;
      const batchId=path.split('/')[1];
      return Response.json({batchId,originalPath:`${batchId}.txt`,deletedAt:`2026-08-${String(Number(batchId.slice(6))+1).padStart(2,'0')}T00:00:00Z`});
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const response=await trashHandler({request:new Request('https://disk.test/api/trash/list',{headers:{Cookie:'hf_session=x'}}),env});
    const body=await response.json();
    expect(body.entries).toHaveLength(20);
    expect(body.pagination).toEqual({page:1,limit:20,totalEntries:25,totalPages:2});
    expect(body.entries[0].batchId).toBe('batch-24');
    expect(list).toHaveBeenCalledWith('.trash',true,{serverRecursive:true,expand:true});
    expect(HuggingFaceAPI.prototype.getFileContent).toHaveBeenCalledTimes(20);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(10);
    const second=await trashHandler({request:new Request('https://disk.test/api/trash/list?page=2',{headers:{Cookie:'hf_session=x'}}),env});
    const secondBody=await second.json();
    expect(secondBody.entries).toHaveLength(5);
    expect(secondBody.pagination.page).toBe(2);
    expect(HuggingFaceAPI.prototype.getFileContent).toHaveBeenCalledTimes(25);
  });

  it('batch deletes files and directories into independent trash entries',async()=>{
    const moveFile=vi.spyOn(HuggingFaceAPI.prototype,'moveFileAtomic').mockResolvedValue(true);
    const moveDirectory=vi.spyOn(HuggingFaceAPI.prototype,'moveDirectoryAtomic').mockResolvedValue({fileCount:2});
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/files/batchDelete',{method:'POST',headers:{Cookie:'hf_session=x','Content-Type':'application/json'},body:JSON.stringify({items:[{path:'one.txt',type:'file'},{path:'folder',type:'directory'}]})});
    const response=await filesHandler({request,env});
    const body=await response.json();
    expect(response.status).toBe(200);
    expect(body.deleted).toBe(2);
    expect(body.failed).toBe(0);
    expect(moveFile).toHaveBeenCalledOnce();
    expect(moveDirectory).toHaveBeenCalledOnce();
    expect(body.results.every(result=>result.batchId&&result.success)).toBe(true);
  });

  it('empties every trash file in bounded commits',async()=>{
    const files=Array.from({length:401},(_,index)=>({path:`.trash/batch-${index}/file.txt`}));
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryRecursive').mockResolvedValue({files,directories:[]});
    const commit=vi.spyOn(HuggingFaceAPI.prototype,'commitOperations').mockResolvedValue({});
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/trash/empty',{method:'POST',headers:{Cookie:'hf_session=x'}});
    const response=await trashHandler({request,env});
    const body=await response.json();
    expect(response.status).toBe(200);
    expect(body.deletedFiles).toBe(401);
    expect(body.commits).toBe(3);
    expect(commit).toHaveBeenCalledTimes(3);
  });
});
