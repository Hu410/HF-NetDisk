export async function runWithConcurrency(itemCount, concurrency, task) {
  let nextIndex = 0;
  let firstError = null;
  async function worker() {
    while (!firstError) {
      const index = nextIndex++;
      if (index >= itemCount) return;
      try {
        await task(index);
      } catch (error) {
        firstError ||= error;
      }
    }
  }
  const workerCount = Math.min(itemCount, Math.max(1, concurrency));
  await Promise.all(Array.from({ length:workerCount }, () => worker()));
  if (firstError) throw firstError;
}
