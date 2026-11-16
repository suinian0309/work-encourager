/**
 * Serves and copies the whale figure's assets.
 *
 * The assets live once, under `assets/whale`, and both apps read them at `/whale/*`: the dev
 * server answers from that folder, a build copies it next to the bundle.
 */
import { createReadStream, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

export function whaleAssetsPlugin(srcDir, outDir) {
  const root = resolve(srcDir);
  return {
    name: 'whale-assets',
    configureServer(server) {
      server.middlewares.use('/whale', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
        const file = resolve(root, rel);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      copyDir(root, join(resolve(outDir), 'whale'));
    },
  };
}
