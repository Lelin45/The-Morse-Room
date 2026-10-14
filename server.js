import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const publicFiles = new Set([
  '/index.html', '/styles.css', '/app.js', '/audio.js', '/trainer.js',
  '/learn-session.js', '/learning-progress.js', '/replay.js', '/chat.js', '/chat-codec.js', '/chat.css',
  '/mobile-shell.js', '/mobile-practice-session.js', '/timed-morse.js',
  '/practice.css', '/practice-round-session.js', '/qwerty-keyboard.js', '/real-word-bank.js',
  '/privacy.html', '/terms.html', '/delete-account.html', '/delete-account.js',
  '/google-signin-light.png', '/google-signin-dark.png',
]);

createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path.startsWith('/api/')) {
      const result = path === '/api/config'
        ? { available: false, providers: { google: false } }
        : path === '/api/me' ? { user: null }
          : { error: { code: 'chat_unavailable', message: 'Chat requires the Cloudflare setup. Learn and Practice work locally without an account.' } };
      response.writeHead(path === '/api/config' || path === '/api/me' ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result));
      return;
    }
    if (path !== '/' && !publicFiles.has(path)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Morse Room is ready at http://localhost:${port}`));
