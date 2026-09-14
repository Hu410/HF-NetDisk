import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { errorResponse, successResponse } from '../utils/response.js';
import { withAuth } from '../middleware/auth.js';
import { sanitizePath } from '../utils/helpers.js';

async function handleMetadataRequest(context) {
  const { request } = context;
  const prefix='/api/meta/';
  const pathname=new URL(request.url).pathname;
  if(request.method!=='GET') return errorResponse('Method not allowed',405,null,'METHOD_NOT_ALLOWED');
  if(!pathname.startsWith(prefix)) return errorResponse('Not found',404,null,'NOT_FOUND');
  const decodedPath=sanitizePath(decodeURIComponent(pathname.slice(prefix.length)));
  if(!decodedPath) return errorResponse('Invalid file path',400,null,'INVALID_PATH');
  const api=new HuggingFaceAPI(context.hfToken,context.hfRepo,context.hfIsPrivate,context.env);
  const headRequest=api.getFileContent(decodedPath,false,null,'HEAD');
  const modificationRequest=(async()=>{
    try {
      const separator=decodedPath.lastIndexOf('/');
      const parentDir=separator>=0?decodedPath.slice(0,separator):'';
      let cursor=null;
      do {
        const options=cursor?{expand:true,cursor}:{expand:true};
        const listing=await api.listDirectory(parentDir,false,options);
        const file=listing.files.find(item=>item.path===decodedPath);
        if(file) return file.lastModified||file.last_modified||null;
        cursor=listing.nextCursor||null;
      } while(cursor);
    } catch {
      // Some upstreams do not support expanded tree metadata; retain the HEAD fallback.
    }
    return null;
  })();
  const [response,lastModified]=await Promise.all([headRequest,modificationRequest]);
  return successResponse({metadata:{
    path:decodedPath,
    exists:response.ok,
    contentType:response.headers.get('Content-Type')||'unknown',
    contentLength:Number(response.headers.get('Content-Length')||0),
    lastModified:lastModified||response.headers.get('Last-Modified')||null,
    etag:response.headers.get('ETag')||null,
  }});
}

export const metadataHandler=withAuth(handleMetadataRequest);
