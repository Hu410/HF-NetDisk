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
      id:'owner/repo',name:'repo',private:true,size:{sizeInBytes:12,nbFiles:1},
      siblings:[{rfilename:'alpha.txt',size:12,type:'file'}],
    });
    const compact=await repoHandler({request:repoRequest('?summary=true'),env});
    const full=await repoHandler({request:repoRequest(),env});
    expect((await compact.json()).info.siblings).toBeUndefined();
    expect((await full.json()).info.siblings).toEqual([{rfilename:'alpha.txt',size:12,type:'file'}]);
  });
});
