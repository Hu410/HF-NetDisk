import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuggingFaceAPI } from '../src/huggingfaceAPI.js';
import { metadataHandler } from '../src/routes/metadata.js';

afterEach(()=>vi.restoreAllMocks());

describe('file metadata',()=>{
  it('falls back to expanded directory metadata for the modification time',async()=>{
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockResolvedValue(
      new Response(null,{status:200,headers:{'Content-Length':'12','Last-Modified':'Sun, 30 Aug 2026 09:59:00 GMT'}}),
    );
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({
      files:[{path:'folder/file.txt',lastModified:'2026-08-30T00:00:00.000Z'}],
      directories:[],
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/meta/folder%2Ffile.txt',{headers:{Cookie:'hf_session=x'}});

    const response=await metadataHandler({request,env});
    const body=await response.json();

    expect(list).toHaveBeenCalledWith('folder',false,{expand:true});
    expect(body.metadata.lastModified).toBe('2026-08-30T00:00:00.000Z');
  });
  it('uses the HEAD modification time when expanded metadata is unavailable',async()=>{
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockResolvedValue(
      new Response(null,{status:200,headers:{'Last-Modified':'Sat, 29 Aug 2026 00:00:00 GMT'}}),
    );
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockRejectedValue(new Error('unsupported'));
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/meta/file.txt',{headers:{Cookie:'hf_session=x'}});

    const response=await metadataHandler({request,env});
    const body=await response.json();

    expect(body.metadata.lastModified).toBe('Sat, 29 Aug 2026 00:00:00 GMT');
  });

  it('loads HEAD and expanded directory metadata concurrently',async()=>{
    let startHead,startList;
    const headStarted=new Promise(resolve=>{startHead=resolve;});
    const listStarted=new Promise(resolve=>{startList=resolve;});
    vi.spyOn(HuggingFaceAPI.prototype,'getFileContent').mockImplementation(async()=>{
      startHead();
      await listStarted;
      return new Response(null,{status:200});
    });
    vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockImplementation(async()=>{
      startList();
      await headStarted;
      return {files:[{path:'file.txt',lastModified:'2026-09-01T00:00:00Z'}],directories:[]};
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const response=await metadataHandler({request:new Request('https://disk.test/api/meta/file.txt',{headers:{Cookie:'hf_session=x'}}),env});
    expect(response.status).toBe(200);
    expect((await response.json()).metadata.lastModified).toBe('2026-09-01T00:00:00Z');
  });
});
