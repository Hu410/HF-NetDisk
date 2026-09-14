import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuggingFaceAPI } from '../src/huggingfaceAPI.js';
import { directoryHandler } from '../src/routes/directory.js';

afterEach(()=>vi.restoreAllMocks());

describe('directory pagination',()=>{
  it('walks every directory page when preparing recursive operations',async()=>{
    const api=new HuggingFaceAPI('token','owner/repo',true,{});
    const list=vi.spyOn(api,'listDirectory')
      .mockResolvedValueOnce({files:[{path:'folder/a.txt'}],directories:[{path:'folder/nested'}],nextCursor:'page-2'})
      .mockResolvedValueOnce({files:[{path:'folder/b.txt'}],directories:[],nextCursor:null})
      .mockResolvedValueOnce({files:[{path:'folder/nested/c.txt'}],directories:[],nextCursor:null});
    const result=await api.listDirectoryRecursive('folder');
    expect(result.files.map(file=>file.path)).toEqual(['folder/a.txt','folder/b.txt','folder/nested/c.txt']);
    expect(list).toHaveBeenNthCalledWith(2,'folder',false,{limit:100,cursor:'page-2'});
    expect(list).toHaveBeenNthCalledWith(3,'folder/nested',false,{limit:100,cursor:null});
  });

  it('clamps limits, forwards cursors and hides system paths',async()=>{
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({
      files:[{path:'file.txt',name:'file.txt'},{path:'.hftags/file.json',name:'file.json'}],
      directories:[{path:'.trash',name:'.trash'}],
      nextCursor:'next-page',
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/directory/list?limit=999&cursor=current',{headers:{Cookie:'hf_session=x'}});
    const response=await directoryHandler({request,env});
    const body=await response.json();
    expect(list).toHaveBeenCalledWith('',false,{limit:100,cursor:'current'});
    expect(body.files.map(file=>file.path)).toEqual(['file.txt']);
    expect(body.directories).toEqual([]);
    expect(body.pagination.nextCursor).toBe('next-page');
  });
  it('requests expanded commit metadata for recent files',async()=>{
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectory').mockResolvedValue({files:[],directories:[],nextCursor:null});
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/directory/list?recursive=true&expand=true',{headers:{Cookie:'hf_session=x'}});
    const response=await directoryHandler({request,env});
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith('',true,{expand:true});
  });

  it('uses the server-recursive paged tree for global search',async()=>{
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({
      files:[{path:'docs/report.txt',name:'docs/report.txt'},{path:'notes.txt',name:'notes.txt'}],directories:[],
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/directory/list?recursive=true&search=report',{headers:{Cookie:'hf_session=x'}});
    const response=await directoryHandler({request,env});
    const body=await response.json();
    expect(body.files.map(file=>file.path)).toEqual(['docs/report.txt']);
    expect(list).toHaveBeenCalledWith('',true,{serverRecursive:true});
  });

  it('returns a compact, complete directory-only tree for the picker',async()=>{
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({
      files:[{path:'docs/guides/start.md'},{path:'images/logo.png'},{path:'.trash/hidden.txt'}],
      directories:[{path:'docs'},{path:'.trash'}],
    });
    const env={HF_TOKEN:'token',HF_REPO:'owner/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const request=new Request('https://disk.test/api/directory/tree?directoriesOnly=true',{headers:{Cookie:'hf_session=x'}});
    const response=await directoryHandler({request,env});
    const body=await response.json();
    expect(body.files).toBeUndefined();
    expect(body.directories.map(directory=>directory.path)).toEqual(['docs','docs/guides','images']);
    expect(list).toHaveBeenCalledWith('',true,{serverRecursive:true});
  });

  it('sorts and caches recent files while returning fixed pages of 20',async()=>{
    const files=Array.from({length:45},(_,index)=>({
      path:`file-${index}.txt`,name:`file-${index}.txt`,type:'file',
      lastModified:new Date(Date.UTC(2026,0,index+1)).toISOString(),
    }));
    const list=vi.spyOn(HuggingFaceAPI.prototype,'listDirectoryAllPages').mockResolvedValue({files,directories:[]});
    const env={HF_TOKEN:'token',HF_REPO:'recent-pagination/repo',HF_PRIVATE:'true',SESSIONS:{idFromName:()=>1,get:()=>({fetch:async()=>Response.json({valid:true})})}};
    const first=await directoryHandler({request:new Request('https://disk.test/api/directory/recent?page=1',{headers:{Cookie:'hf_session=x'}}),env});
    const second=await directoryHandler({request:new Request('https://disk.test/api/directory/recent?page=2',{headers:{Cookie:'hf_session=x'}}),env});
    const firstBody=await first.json(),secondBody=await second.json();
    expect(firstBody.files).toHaveLength(20);
    expect(firstBody.files[0].path).toBe('file-44.txt');
    expect(secondBody.files).toHaveLength(20);
    expect(secondBody.pagination).toEqual({page:2,limit:20,totalFiles:45,totalPages:3});
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('',true,{expand:true,serverRecursive:true});
  });
});
