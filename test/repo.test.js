import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuggingFaceAPI } from '../src/huggingfaceAPI.js';
import { repoHandler } from '../src/routes/repo.js';

afterEach(()=>vi.restoreAllMocks());

const env={
  HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',
  SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})},
};

function repoRequest(query='') {
  return new Request(`https://disk.test/api/repo/info${query}`,{headers:{Cookie:'hf_session=x'}});
}

describe('repository summary',()=>{
  it('omits repository siblings only for the compact WebUI summary',async()=>{
    vi.spyOn(HuggingFaceAPI.prototype,'getRepoInfo').mockResolvedValue({
      id:'owner/repo',name:'repo',private:true,usedStorage:12,size:{nbFiles:1},
      siblings:[{rfilename:'alpha.txt',size:12,type:'file'}],
    });
    const compact=await repoHandler({request:repoRequest('?summary=true'),env});
    const full=await repoHandler({request:repoRequest(),env});
    const compactInfo=(await compact.json()).info;
    expect(compactInfo.siblings).toBeUndefined();
    expect(compactInfo.size).toEqual({sizeInBytes:12,nbFiles:1});
    expect((await full.json()).info.siblings).toEqual([{rfilename:'alpha.txt',size:12,type:'file'}]);
  });

  it('falls back to summing the expanded repository tree when storage is absent',async()=>{
    vi.spyOn(HuggingFaceAPI.prototype,'getRepoInfo').mockResolvedValue({
      id:'owner/repo',name:'repo',private:true,
    });
    const listTree=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({
      files:[{path:'alpha.txt',size:12},{path:'beta.bin',size:30}],
      directories:[{path:'folder'}],
    });

    const response=await repoHandler({request:repoRequest('?summary=true'),env});
    expect((await response.json()).info.size.sizeInBytes).toBe(42);
    expect(listTree).toHaveBeenCalledWith('',true,{
      serverRecursive:true,
      expand:true,
    });
  });
});
