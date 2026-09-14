import { describe, expect, it } from 'vitest';
import { runWithConcurrency } from '../frontend/js/utils/concurrency.js';

describe('frontend upload concurrency',()=>{
  it('runs every part with no more than three active uploads',async()=>{
    let active=0,maxActive=0;
    const completed=[];
    await runWithConcurrency(8,3,async index=>{
      active++;
      maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,2));
      completed.push(index);
      active--;
    });
    expect(completed.sort((a,b)=>a-b)).toEqual([0,1,2,3,4,5,6,7]);
    expect(maxActive).toBe(3);
  });

  it('stops scheduling new parts after a failure and waits for active uploads',async()=>{
    const started=[];
    await expect(runWithConcurrency(8,3,async index=>{
      started.push(index);
      await new Promise(resolve=>setTimeout(resolve,index===1?1:4));
      if(index===1)throw new Error('part failed');
    })).rejects.toThrow('part failed');
    expect(started.length).toBeLessThan(8);
  });
});
