import { describe, expect, it, vi } from 'vitest';
import { createFrameScheduler } from '../frontend/js/utils/frameScheduler.js';

describe('frame scheduler',()=>{
  it('coalesces repeated progress updates into one render per frame',()=>{
    const callbacks=[];
    const render=vi.fn();
    const schedule=createFrameScheduler(render,callback=>{
      callbacks.push(callback);
      return callbacks.length;
    });
    schedule();
    schedule();
    schedule();
    expect(callbacks).toHaveLength(1);
    expect(render).not.toHaveBeenCalled();
    callbacks.shift()();
    expect(render).toHaveBeenCalledOnce();
    schedule();
    expect(callbacks).toHaveLength(1);
  });
});
