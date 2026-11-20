// Serves the static export the way CloudFront + the index-rewrite function does (infra/aws/frontend-stack.yaml).
//   pnpm serve:export [dir=out] [port=3000]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.argv[2] ?? fileURLToPath(new URL('../out', import.meta.url)); const port = Number(process.argv[3] ?? 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain', '.ico': 'image/x-icon', '.png': 'image/png', '.mp3': 'audio/mpeg' };
createServer(async (req, res) => {
  let uri = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (uri.endsWith('/')) uri += 'index.html'; else if (!uri.includes('.')) uri += '/index.html';
  const file = join(root, uri);
  try {
    const s = await stat(file); if (!s.isFile()) throw new Error();
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/html' }); res.end(await readFile(join(root, '404.html')).catch(() => 'not found'));
  }
})
  .on('error', (err) => {
    // A stale `next dev` on the same port answers every request and quietly makes the
    // e2e run test the wrong build. Say so instead of exiting with a stack trace.
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} is already in use — stop whatever is on it (lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
      process.exit(1);
    }
    throw err;
  })
  .listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
