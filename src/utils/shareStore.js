export function getShareStub(env) {
  if (!env.SHARES) throw new Error('SHARES Durable Object binding is not configured');
  return env.SHARES.get(env.SHARES.idFromName('global'));
}

export async function shareStoreRequest(env, path, body = {}) {
  return getShareStub(env).fetch(`https://shares${path}`, {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body),
  });
}
