import {watch} from 'node:fs';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {pipeline} from 'node:stream';
import {extname, resolve, sep} from 'node:path';

import {buildPages, output, root} from './build-pages.mjs';

const port = Number(process.env.PORT ?? 8001);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

await buildPages();
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  // Match the legacy server's policy: generated output must never make a
  // dotfile (including a future accidental .env) available over HTTP.
  if (pathname.includes('/.')) return response.writeHead(404).end('Not found');
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filename = resolve(output, requested);
  if (!filename.startsWith(`${output}${sep}`)) return response.writeHead(403).end('Forbidden');
  try {
    if (!(await stat(filename)).isFile()) throw new Error('Not a file');
    response.writeHead(200, {'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream'});
    pipeline(createReadStream(filename), response, (error) => {
      if (error && !response.destroyed) response.destroy(error);
    });
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`Pages demo listening on http://localhost:${port}`));

const watchedDirectories = [
  'pages', 'packages/core/src', 'packages/codemirror-editor/src', 'packages/editor/src',
  'packages/javascript-adapter/src', 'packages/python-adapter/src'
];
let rebuildTimer;
for (const directory of watchedDirectories) {
  watch(resolve(root, directory), {recursive: true}, () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      try {
        await buildPages();
        console.log('Rebuilt Pages demo.');
      } catch (error) {
        console.error('Pages rebuild failed:', error);
      }
    }, 80);
  });
}
