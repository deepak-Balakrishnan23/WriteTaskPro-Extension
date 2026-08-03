/* =========================================================
   Copies the Harper engine out of node_modules into vendor/,
   which is what actually ships in the extension package.

   Manifest V3 forbids remotely hosted code, so the .wasm must be
   inside the package — fetching it from a CDN would be a policy
   violation, not just a slower start.

   Run: npm run vendor
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'node_modules', 'harper.js', 'dist');
const TO = path.join(ROOT, 'vendor', 'harper');

if (!fs.existsSync(FROM)) {
  console.error('harper.js is not installed. Run: npm install');
  process.exit(1);
}

/* The full glue flavor, not binaryInlined — base64-inlining the wasm
   costs an extra 33% for no benefit when we control the file layout. */
const REQUIRED = ['index.js', 'harper_wasm_bg.wasm'];

/* index.js imports a hashed chunk; copy whatever it actually references
   rather than hard-coding a filename that changes on every release. */
function findChunks() {
  const source = fs.readFileSync(path.join(FROM, 'index.js'), 'utf8');
  return [...source.matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
}

fs.rmSync(TO, { recursive: true, force: true });
fs.mkdirSync(TO, { recursive: true });

const files = [...new Set([...REQUIRED, ...findChunks()])];
let total = 0;

for (const file of files) {
  const source = path.join(FROM, file);
  if (!fs.existsSync(source)) {
    console.error(`missing expected file: ${file}`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(TO, file));
  const { size } = fs.statSync(source);
  total += size;
  console.log(`  ${file.padEnd(34)} ${String(size).padStart(10)} bytes`);
}

const version = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'harper.js', 'package.json'), 'utf8')
).version;

fs.writeFileSync(
  path.join(TO, 'VERSION'),
  `harper.js ${version}\nApache-2.0\nCopied by scripts/vendor-harper.mjs — do not edit by hand.\n`
);

console.log(`\nharper.js ${version} → vendor/harper (${(total / 1048576).toFixed(2)} MB uncompressed)`);
