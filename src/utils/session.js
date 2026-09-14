export function getSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'hf_session') return value.join('=');
  }
  return null;
}

export function getSessionStub(env) {
  if (!env.SESSIONS) throw new Error('SESSIONS Durable Object binding is not configured');
  return env.SESSIONS.get(env.SESSIONS.idFromName('global'));
}

export async function verifySession(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return false;
  const result = await getSessionStub(env).fetch('https://session/session/verify', {
    method: 'POST', body: JSON.stringify({ sessionId }),
  }).then(response => response.json());
  return result.valid === true;
}
