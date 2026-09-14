import { runWithConcurrency } from './utils/concurrency.js';

export const API = (() => {
  'use strict';

  function buildUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
    return url.toString();
  }

  async function request(method, path, options = {}) {
    const url = buildUrl(path, options.params);
    const init = { method, signal: options.signal };
    if (options.formData) {
      init.body = options.formData;
    } else if (options.body !== undefined) {
      init.headers = { 'Content-Type':'application/json' };
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    if (options.raw) {
      if (!response.ok) throw await responseError(response);
      return response;
    }
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.error === 'object' ? data.error.message : data.error;
      const error = new Error(message || data.message || `HTTP ${response.status}`);
      error.code = data.code || data.error?.code || 'REQUEST_FAILED';
      error.requestId = data.requestId || response.headers.get('X-Request-Id');
      throw error;
    }
    const { success: _success, message: _message, ...result } = data;
    return result;
  }

  return {
    getAuthStatus: () => request('GET','/api/auth/status'),
    login: (password,remember=false) => request('POST','/api/auth/login',{body:{password,remember}}),
    logout: () => request('POST','/api/auth/logout'),
    getRepoInfo: () => request('GET','/api/repo/info',{params:{summary:true}}),

    uploadFileWithProgress: (file,dir='',fileName='',onProgress=null,conflictPolicy='reject') =>
      xhrUploadForm(file,dir,fileName,conflictPolicy,onProgress),
    uploadLfsWithProgress: (file,dir='',fileName='',onProgress=null,conflictPolicy='reject') =>
      uploadLfs(file,dir,fileName,onProgress,conflictPolicy),

    getFileDownloadUrl: filePath => {
      const url = new URL(`/api/files/${encodeURIComponent(filePath)}`,window.location.origin);
      url.searchParams.set('download','1');
      return url.toString();
    },
    deleteFile: (filePath,type='file') => request('DELETE',`/api/files/${encodeURIComponent(filePath)}`,{params:{type}}),
    batchDelete: items => request('POST','/api/files/batchDelete',{body:{items}}),
    listTrash: (page=1,options={}) => request('GET','/api/trash/list',{params:{page},signal:options.signal}),
    restoreTrash: (batchId,conflictPolicy='reject',targetPath=null) => request('POST','/api/trash/restore',{body:{batchId,conflictPolicy,targetPath}}),
    purgeTrash: batchId => request('POST','/api/trash/purge',{body:{batchId}}),
    emptyTrash: () => request('POST','/api/trash/empty',{body:{}}),
    renameFile: (oldPath,newPath,conflictPolicy='reject') => request('POST','/api/files/rename',{body:{oldPath,newPath,conflictPolicy}}),
    listDirectory: (dir='',options={}) => {
      const { signal, ...params } = options;
      return request('GET','/api/directory/list',{params:{...params,...(dir?{dir}:{})},signal});
    },
    listRecent: (page=1,options={}) => request('GET','/api/directory/recent',{params:{page},signal:options.signal}),
    getDirectoryTree: () => request('GET','/api/directory/tree',{params:{directoriesOnly:true}}),
    getFileMeta: (filePath,options={}) => request('GET',`/api/meta/${encodeURIComponent(filePath)}`,{signal:options.signal}),
    createShare: (path,type,expiresIn,password='') => request('POST','/api/shares',{body:{path,type,expiresIn,password}}),
    listShares: (page=1,options={}) => request('GET','/api/shares',{params:{page},signal:options.signal}),
    revokeShare: id => request('DELETE',`/api/shares/${encodeURIComponent(id)}`),
  };

  async function uploadLfs(file,dir,fileName,onProgress,conflictPolicy) {
    const name=fileName||file.name;
    const filePath=dir?`${dir}/${name}`:name;
    const emit=info=>{if(onProgress)onProgress(info);};
    emit(progress(0,'hashing',0,1,0,0,file.size,0));
    const oid=await computeSHA256(file);
    const sampleBytes=new Uint8Array(await file.slice(0,512).arrayBuffer());
    const fileSample=btoa(String.fromCharCode(...sampleBytes));
    const info=await request('POST','/api/files/getUploadUrl',{body:{fileSize:file.size,sha256:oid,fileSample,fileName:name,filePath,conflictPolicy}});
    if(!info.needsLfs) return xhrUploadForm(file,dir,fileName,conflictPolicy,pct=>emit(progress(pct,'uploading',0,1,pct,file.size*pct/100,file.size,0)));
    const startedAt=Date.now();
    if(!info.alreadyExists){
      const count=info.mode==='multipart'?info.totalParts:1;
      const chunks=Array.from({length:count},(_,index)=>{
        const start=info.mode==='multipart'?index*info.chunkSize:0;
        const end=info.mode==='multipart'?Math.min(start+info.chunkSize,file.size):file.size;
        return {loaded:0,size:end-start,status:'pending'};
      });
      const uploadPart=async index=>{
        const partNumber=info.mode==='multipart'?index+1:0;
        const start=info.mode==='multipart'?index*info.chunkSize:0;
        const end=info.mode==='multipart'?Math.min(start+info.chunkSize,file.size):file.size;
        const chunk=file.slice(start,end);
        chunks[index].status='uploading';
        await xhrPutBinary(info.uploadId,partNumber,chunk,(pct,loaded)=>{
          chunks[index].loaded=Math.min(chunk.size,loaded||chunk.size*pct/100);
          const totalLoaded=chunks.reduce((sum,item)=>sum+item.loaded,0);
          const elapsed=Math.max(.001,(Date.now()-startedAt)/1000);
          emit(progress(10+(totalLoaded/file.size)*85,'uploading',index,count,pct,chunks[index].loaded,chunk.size,totalLoaded/elapsed,chunks));
        });
        chunks[index].loaded=chunk.size;
        chunks[index].status='done';
        const totalLoaded=chunks.reduce((sum,item)=>sum+item.loaded,0);
        const elapsed=Math.max(.001,(Date.now()-startedAt)/1000);
        emit(progress(10+(totalLoaded/file.size)*85,'uploading',index,count,100,chunk.size,chunk.size,totalLoaded/elapsed,chunks));
      };
      await runWithConcurrency(count,info.mode==='multipart'?3:1,uploadPart);
    }
    await request('POST','/api/files/completeMultipart',{body:{uploadId:info.uploadId}});
    emit(progress(95,'committing',0,1,0,0,0,0));
    await request('POST','/api/files/commit',{body:{uploadId:info.uploadId}});
    emit(progress(100,'done',0,1,100,file.size,file.size,0));
    return {success:true,filePath:info.filePath||filePath,oid,fileSize:file.size};
  }

  function progress(pct,stage,chunkIndex,chunkTotal,chunkPct,chunkLoaded,chunkSize,speed,chunks=null){
    return {pct,stage,chunkIndex,chunkTotal,chunkPct,chunkLoaded,chunkSize,speed,chunks:chunks?.map(chunk=>({...chunk}))||null};
  }

  function uploadForm(file,dir,fileName,conflictPolicy){
    const formData=new FormData();
    formData.append('file',file);
    if(dir)formData.append('dir',dir);
    if(fileName)formData.append('fileName',fileName);
    formData.append('conflictPolicy',conflictPolicy);
    return formData;
  }

  function xhrUploadForm(file,dir,fileName,conflictPolicy,onProgress){
    return xhrRequest('PUT',buildUrl('/api/files/upload'),uploadForm(file,dir,fileName,conflictPolicy),null,onProgress);
  }

  function xhrPutBinary(uploadId,partNumber,blob,onProgress){
    const url=new URL('/api/files/lfsUpload',window.location.origin);
    url.searchParams.set('uploadId',uploadId);
    url.searchParams.set('partNumber',String(partNumber));
    return xhrRequest('PUT',url.toString(),blob,'application/octet-stream',onProgress);
  }

  function xhrRequest(method,url,body,contentType,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open(method,url);
      if(contentType)xhr.setRequestHeader('Content-Type',contentType);
      xhr.upload.onprogress=event=>{if(event.lengthComputable&&onProgress)onProgress(Math.round(event.loaded/event.total*100),event.loaded);};
      xhr.onload=()=>{
        let data={};
        try{data=JSON.parse(xhr.responseText);}catch{/* handled below */}
        if(xhr.status>=200&&xhr.status<300){const{success:_success,message:_message,...result}=data;resolve(result);}else reject(new Error(data.error||`HTTP ${xhr.status}`));
      };
      xhr.onerror=()=>reject(new Error('网络错误'));
      xhr.send(body);
    });
  }

  function computeSHA256(file){
    return new Promise((resolve,reject)=>{
      const worker=new Worker('/js/sha256-worker.js');
      worker.onmessage=event=>{
        if(event.data.type==='done'){worker.terminate();resolve(event.data.hash);}
        if(event.data.type==='error'){worker.terminate();reject(new Error(event.data.message));}
      };
      worker.onerror=error=>{worker.terminate();reject(error);};
      worker.postMessage({file,chunkSize:8*1024*1024});
    });
  }

  async function responseError(response){
    const data=await response.json().catch(()=>({}));
    return new Error(data.error||`HTTP ${response.status}`);
  }
})();
