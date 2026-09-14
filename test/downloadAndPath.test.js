import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesHandler } from '../src/routes/files.js';
import { encodeFilePath, sanitizePath } from '../src/utils/helpers.js';

function env(isPrivate, mirror = false) {
  return {
    HF_TOKEN:'token', HF_REPO:'owner/repo', HF_PRIVATE:isPrivate?'true':'false',
    ...(mirror ? { HF_MIRROR_URL:'https://hf-mirror.com/', HF_MIRROR_ALLOWED_HOSTS:'hf-mirror.com' } : {}),
    SESSIONS:{ idFromName:()=>1, get:()=>({fetch:async()=>Response.json({valid:true})}) },
  };
}

afterEach(()=>vi.unstubAllGlobals());

describe('path normalization',()=>{
  it('keeps normalized Chinese paths and encodes each segment',()=>{
    expect(sanitizePath('目录/文件 #1.txt')).toBe('目录/文件 #1.txt');
    expect(encodeFilePath('目录/文件 #1.txt')).toBe('%E7%9B%AE%E5%BD%95/%E6%96%87%E4%BB%B6%20%231.txt');
  });
  it('rejects traversal, backslashes and empty segments',()=>{
    expect(sanitizePath('../secret')).toBe('');
    expect(sanitizePath('a\\b')).toBe('');
    expect(sanitizePath('a//b')).toBe('');
  });
});

describe('downloads',()=>{
  it('redirects public files to the official Hugging Face URL',async()=>{
    const request=new Request('https://disk.test/api/files/%E7%9B%AE%E5%BD%95%2Ffile.txt',{headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env:env(false)});
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://huggingface.co/datasets/owner/repo/resolve/main/%E7%9B%AE%E5%BD%95/file.txt');
  });
  it('redirects public files to an allowlisted mirror',async()=>{
    const request=new Request('https://disk.test/api/files/folder%2Ffile.txt',{headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env:env(false,true)});
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://hf-mirror.com/datasets/owner/repo/resolve/main/folder/file.txt');
  });
  it('streams explicit public downloads so UTF-8 filenames remain under application control',async()=>{
    vi.stubGlobal('fetch',async()=>new Response('data'));
    const request=new Request('https://disk.test/api/files/%E4%B8%AD%E6%96%87.txt?download=1',{headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env:env(false)});
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="__.txt"; filename*=UTF-8\'\'%E4%B8%AD%E6%96%87.txt',
    );
  });
  it('does not use a mirror for private repositories',async()=>{
    let upstreamUrl;
    vi.stubGlobal('fetch',async url=>{upstreamUrl=url;return new Response('data');});
    const request=new Request('https://disk.test/api/files/file.txt',{headers:{Cookie:'hf_session=x'}});
    await filesHandler({request,env:{...env(true,true)}});
    expect(upstreamUrl).toBe('https://huggingface.co/datasets/owner/repo/resolve/main/file.txt');
  });
  it('forwards Range for private streaming downloads',async()=>{
    let upstream;
    vi.stubGlobal('fetch',async(requestUrl,init)=>{
      upstream={requestUrl,init};
      return new Response('data',{status:206,headers:{'Content-Range':'bytes 0-3/10','Content-Length':'4','Accept-Ranges':'bytes'}});
    });
    const request=new Request('https://disk.test/api/files/file.bin',{headers:{Cookie:'hf_session=x',Range:'bytes=0-3'}});
    const response=await filesHandler({request,env:env(true)});
    expect(response.status).toBe(206);
    expect(upstream.init.headers.Range).toBe('bytes=0-3');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('uses RFC 5987 UTF-8 filenames for Chinese downloads',async()=>{
    vi.stubGlobal('fetch',async()=>new Response('data'));
    const request=new Request('https://disk.test/api/files/%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6%281%29.txt?download=1',{headers:{Cookie:'hf_session=x'}});
    const response=await filesHandler({request,env:env(true)});
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="__ __(1).txt"; filename*=UTF-8\'\'%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6%281%29.txt',
    );
  });
});
