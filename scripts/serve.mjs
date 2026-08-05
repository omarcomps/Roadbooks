// Plain static file server, no dependencies. The app is now split into ES
// modules, and browsers refuse to load those over file:// -- this is just
// enough of a server to open index.html correctly while developing.
//
// Usage:  node scripts/serve.mjs [port]     (defaults to 8080)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(root, requestPath === '/' ? '/index.html' : requestPath);

  // Don't serve anything outside the project root.
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + requestPath); return; }
    const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log('Roadbooks dev server running at http://localhost:' + port);
});
