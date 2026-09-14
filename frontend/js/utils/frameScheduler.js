export function createFrameScheduler(callback, schedule = requestAnimationFrame) {
  let pendingFrame = null;
  return () => {
    if (pendingFrame !== null) return;
    pendingFrame = schedule(() => {
      pendingFrame = null;
      callback();
    });
  };
}
