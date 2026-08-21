import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

  if (pathname.includes('/.')) {
    response.writeHead(404).end('Not found');
    return;
  }

  const filename = resolve(workspaceRoot, `.${pathname}`);

  if (filename !== workspaceRoot && !filename.startsWith(`${workspaceRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) throw new Error('Not a file');

    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream'
    });
    pipeline(createReadStream(filename), response, (error) => {
      if (error && !response.destroyed) response.destroy(error);
    });
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(8942, '127.0.0.1', () => {
  console.log('Playwright QUnit server listening on http://127.0.0.1:8942');
});
