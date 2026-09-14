import { afterEach, describe, expect, it, vi } from 'vitest';
import { API } from '../frontend/js/api.js';

afterEach(()=>{
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('frontend multipart upload',()=>{
  it('uploads at most three parts concurrently and completes after every part',async()=>{
    let active=0,maxActive=0,completedParts=0;
    class FakeWorker {
      postMessage(){ queueMicrotask(()=>this.onmessage({data:{type:'done',hash:'a'.repeat(64)}})); }
      terminate(){}
    }
    class FakeXHR {
      constructor(){ this.upload={}; this.status=200; this.responseText='{"success":true}'; }
      open(_method,url){ this.url=url; }
      setRequestHeader(){}
      send(body){
        active++;
        maxActive=Math.max(maxActive,active);
        this.upload.onprogress?.({lengthComputable:true,loaded:body.size,total:body.size});
        setTimeout(()=>{
          completedParts++;
          active--;
          this.onload();
        },4);
      }
    }
    vi.stubGlobal('window',{location:{origin:'https://disk.test'}});
    vi.stubGlobal('Worker',FakeWorker);
    vi.stubGlobal('XMLHttpRequest',FakeXHR);
    vi.stubGlobal('fetch',vi.fn(async input=>{
      const path=new URL(input).pathname;
      if(path.endsWith('/getUploadUrl')) return Response.json({success:true,needsLfs:true,alreadyExists:false,uploadId:'upload-id',mode:'multipart',chunkSize:4,totalParts:4,filePath:'large.bin'});
      if(path.endsWith('/completeMultipart')){
        expect(completedParts).toBe(4);
        return Response.json({success:true});
      }
      if(path.endsWith('/commit')) return Response.json({success:true});
      throw new Error(`Unexpected request: ${path}`);
    }));
    const file=new Blob([new Uint8Array(16)]);
    Object.defineProperty(file,'name',{value:'large.bin'});
    const updates=[];
    await API.uploadLfsWithProgress(file,'','',update=>updates.push(update));
    expect(maxActive).toBe(3);
    expect(completedParts).toBe(4);
    expect(updates.some(update=>update.chunks?.filter(chunk=>chunk.status==='uploading').length>1)).toBe(true);
  });
});
