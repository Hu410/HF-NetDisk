import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('frontend');
const port = Number(process.env.PORT || 8788);
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(join(root, normalize(relative)));
    if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) throw new Error('Invalid path');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  } catch {
    if (request.method === 'GET' && !pathname.startsWith('/api/') && !extname(pathname)) {
      response.writeHead(200, { 'Content-Type': mime['.html'] });
      createReadStream(join(root, 'index.html')).pipe(response);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Static test server listening on ${port}`));

function shutdown() {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
