/* =========================================================
   WriteTask Pro — Grammar engine worker

   Owns the single Harper WASM instance and does all linting off
   the main thread. Loaded as a module worker from a bundled,
   same-origin file.

   Why not Harper's own WorkerLinter: it spawns its worker from a
   blob: URL with a data: URL fallback. Manifest V3 resolves worker
   creation against script-src, which is pinned to
   "'self' 'wasm-unsafe-eval'" and cannot be relaxed to allow blob:.
   So we run LocalLinter inside a worker we create ourselves.

   Workers have no chrome.* APIs, so the .wasm URL is resolved by
   the offscreen document and passed in with the init message.
   ========================================================= */

import { LocalLinter, Dialect, createBinaryModuleFromUrl } from '../vendor/harper/index.js';
import { makeIssue, dropOverlapping } from '../lib/issues.js';

let linter = null;
let ready = null;

const DIALECTS = {
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian
};

/* Instantiating the WASM costs roughly half a second, so it happens once
   and every later lint awaits the same promise. */
function setup({ wasmUrl, dialect = 'american' }) {
  if (ready) return ready;

  ready = (async () => {
    const binary = createBinaryModuleFromUrl(wasmUrl, 'full');
    linter = new LocalLinter({
      binary,
      dialect: DIALECTS[dialect] ?? Dialect.American
    });
    await linter.setup();
  })();

  return ready;
}

/* Harper's Lint objects hold pointers into WASM memory and cannot cross a
   postMessage boundary, so each one is flattened into the plain contract
   from lib/issues.js before it leaves this worker. */
function toIssues(lints, text) {
  const issues = [];

  for (const lint of lints) {
    let span;
    try {
      span = lint.span();
    } catch (err) {
      console.debug('[WriteTask Pro] unreadable lint span', err);
      continue;
    }

    const suggestions = lint.suggestions().map((suggestion) => ({
      kind: suggestion.kind(),
      text: suggestion.get_replacement_text()
    }));

    const issue = makeIssue(
      {
        start: span.start,
        end: span.end,
        kind: lint.lint_kind(),
        message: lint.message(),
        suggestions
      },
      text
    );

    if (issue) issues.push(issue);
  }

  // Two marks over the same characters read as a rendering bug.
  return dropOverlapping(issues);
}

async function lint(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  await ready;
  return toIssues(await linter.lint(source), source);
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data || {};

  try {
    switch (type) {
      case 'init':
        await setup(payload || {});
        self.postMessage({ id, ok: true, result: { ready: true } });
        break;

      case 'lint':
        self.postMessage({ id, ok: true, result: await lint(payload?.text) });
        break;

      default:
        self.postMessage({ id, ok: false, error: `Unknown worker message: ${type}` });
    }
  } catch (err) {
    // Never leave a request unanswered; a silent worker looks like a hang.
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
