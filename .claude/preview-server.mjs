// Static file server for previewing WriteTask Pro's HTML/CSS in the browser pane.
// Chrome extension APIs (chrome.*) are unavailable over plain HTTP, so this is a
// visual/layout preview only — load the folder as an unpacked extension for real use.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = process.env.PORT || 5050; // honors the harness-assigned port; no hardcoded flag
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/sidebar.html';
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`WriteTask Pro static preview running on http://localhost:${port}`);
  console.log('Pages: /sidebar.html  /popup.html  (layout only — chrome.* APIs are inert here)');
});
