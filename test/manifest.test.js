/* =========================================================
   Checks the extension package holds together: every file the
   manifest names exists, and every import in the module graph
   resolves. A service worker that fails to load is invisible
   until you open chrome://extensions.
   ========================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

test('manifest is version 3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('the service worker file exists', () => {
  assert.ok(manifest.background?.service_worker, 'no service worker declared');
  assert.ok(exists(manifest.background.service_worker), 'service worker file is missing');
});

test('the service worker is declared as a module, matching its import syntax', () => {
  const source = fs.readFileSync(path.join(ROOT, manifest.background.service_worker), 'utf8');
  const usesImports = /^import\s/m.test(source);
  if (usesImports) {
    assert.equal(
      manifest.background.type,
      'module',
      'background.js uses import statements but is not declared as type "module" — Chrome will refuse to load it'
    );
  }
});

test('every content script file exists', () => {
  for (const entry of manifest.content_scripts || []) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) {
      assert.ok(exists(file), `content script file missing: ${file}`);
    }
  }
});

test('every icon exists', () => {
  const sets = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
  for (const set of sets) {
    for (const file of Object.values(set)) {
      assert.ok(exists(file), `icon missing: ${file}`);
    }
  }
});

test('the popup exists', () => {
  assert.ok(exists(manifest.action.default_popup));
});

test('web accessible resources exist', () => {
  for (const entry of manifest.web_accessible_resources || []) {
    for (const resource of entry.resources || []) {
      if (resource.includes('*')) continue;
      assert.ok(exists(resource), `web accessible resource missing: ${resource}`);
    }
  }
});

/* ── Module graph resolves ────────────────────────────────────
   Chrome will not tell you which import failed; it just reports
   that the service worker did not register.
   ───────────────────────────────────────────────────────────── */

test('every relative import in the module graph resolves', () => {
  const seen = new Set();
  const queue = [manifest.background.service_worker];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);

    for (const specifier of specifiers) {
      const resolved = path.normalize(path.join(path.dirname(file), specifier));
      assert.ok(exists(resolved), `${file} imports ${specifier}, which does not exist`);
      queue.push(resolved);
    }
  }

  // Sanity: the graph should have reached the lib modules, not just background.js.
  assert.ok(seen.size > 1, 'module graph traversal found no imports at all');
});

/* ── Phase 1: the grammar engine wiring ───────────────────────
   Each of these can only fail at runtime in Chrome, silently.
   ───────────────────────────────────────────────────────────── */

test('CSP allows WebAssembly instantiation', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(
    csp,
    /'wasm-unsafe-eval'/,
    "without 'wasm-unsafe-eval' the Harper WASM cannot instantiate and every check fails"
  );
});

test('CSP does not attempt to use forbidden sources', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  // Chrome rejects the whole manifest if extension_pages is relaxed past the minimum.
  assert.doesNotMatch(csp, /'unsafe-eval'(?!\s*;?\s*$)|blob:|https?:/, `CSP too permissive: ${csp}`);
  assert.doesNotMatch(csp, /'unsafe-inline'/, 'unsafe-inline is rejected in MV3');
});

test('the offscreen permission is requested', () => {
  assert.ok(
    (manifest.permissions || []).includes('offscreen'),
    'chrome.offscreen.createDocument throws without the offscreen permission'
  );
});

test('the offscreen document and its scripts exist', () => {
  assert.ok(exists('offscreen.html'), 'offscreen.html is missing');
  assert.ok(exists('engine/offscreen.js'), 'engine/offscreen.js is missing');
  assert.ok(exists('engine/harper-worker.js'), 'engine/harper-worker.js is missing');
});

test('the vendored engine is present in the package', () => {
  // node_modules is not shipped; vendor/ is. Run: npm run vendor
  assert.ok(exists('vendor/harper/harper_wasm_bg.wasm'), 'run "npm run vendor"');
  assert.ok(exists('vendor/harper/index.js'), 'run "npm run vendor"');
});

test('the vendored engine matches the installed harper.js version', () => {
  const installed = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'harper.js', 'package.json'), 'utf8')
  ).version;
  const vendored = fs.readFileSync(path.join(ROOT, 'vendor', 'harper', 'VERSION'), 'utf8');
  assert.match(
    vendored,
    new RegExp(`harper\\.js ${installed.replace(/\./g, '\\.')}`),
    `vendor/ holds a different version than node_modules (${installed}) — run "npm run vendor"`
  );
});

test('every relative import in the offscreen and worker graph resolves', () => {
  for (const entry of ['engine/offscreen.js', 'engine/harper-worker.js']) {
    const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const resolved = path.normalize(path.join(path.dirname(entry), specifier));
      assert.ok(exists(resolved), `${entry} imports ${specifier}, which does not exist`);
    }
  }
});

test('the worker is loaded as a module, matching its import syntax', () => {
  const host = fs.readFileSync(path.join(ROOT, 'engine/offscreen.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'engine/harper-worker.js'), 'utf8');
  if (/^import\s/m.test(worker)) {
    assert.match(
      host,
      /type:\s*'module'/,
      'harper-worker.js uses imports but is not created with { type: "module" }'
    );
  }
});

test('the engine is never fetched from a remote origin', () => {
  // MV3 forbids remotely hosted code; the wasm must come from the package.
  for (const entry of ['engine/offscreen.js', 'engine/harper-worker.js', 'lib/engine-client.js']) {
    const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    assert.doesNotMatch(
      source,
      /https?:\/\/(?!\S*(developer\.chrome|github|example))/,
      `${entry} references a remote URL`
    );
  }
});

test('the offscreen reason has no automatic teardown', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/engine-client.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /Reason\.AUDIO_PLAYBACK/,
    'AUDIO_PLAYBACK closes the document after 30s without audio, defeating the point'
  );
  assert.match(source, /Reason\.WORKERS/, 'expected the WORKERS reason');
});

test('no lingering permission is requested that the code never uses', () => {
  // notifications is not requested yet — reminders currently surface only as a
  // badge. Recorded here so adding the permission is a deliberate change.
  assert.equal(
    (manifest.permissions || []).includes('notifications'),
    false,
    'notifications permission was added — wire up chrome.notifications and update this test'
  );
});
