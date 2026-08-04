/* =========================================================
   Tasve — Offscreen engine host

   The service worker is killed after 30 seconds idle, and bringing
   Harper back up costs about half a second of WASM compilation. An
   offscreen document has no lifetime limit for non-audio reasons,
   so the engine is instantiated once and stays warm.

   It also has to be exactly one instance: each Harper linter retains
   roughly 155 MB of WASM linear memory, so a per-tab content script
   copy would cost gigabytes across a normal browsing session.

   Content scripts cannot message an offscreen document directly, so
   traffic goes content script → service worker → here.
   ========================================================= */

const WASM_URL = chrome.runtime.getURL('vendor/harper/harper_wasm_bg.wasm');

const worker = new Worker(chrome.runtime.getURL('engine/harper-worker.js'), {
  type: 'module',
  name: 'writetask-harper'
});

const pending = new Map();
let nextId = 1;

worker.addEventListener('message', (event) => {
  const { id, ok, result, error } = event.data || {};
  const settle = pending.get(id);
  if (!settle) return;
  pending.delete(id);
  if (ok) settle.resolve(result);
  else settle.reject(new Error(error || 'Engine request failed'));
});

worker.addEventListener('error', (event) => {
  // A module-worker load failure lands here and would otherwise strand
  // every caller. Fail them all loudly instead.
  const message = event.message || 'Grammar engine worker failed to load';
  console.error('[Tasve] engine worker error:', message);
  for (const [id, settle] of pending) {
    pending.delete(id);
    settle.reject(new Error(message));
  }
});

function callWorker(type, payload, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Grammar engine timed out on "${type}"`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });

    worker.postMessage({ id, type, payload });
  });
}

/* Kicked off immediately rather than on first use, so the half-second
   WASM compile overlaps with the user still typing. */
const engineReady = callWorker('init', { wasmUrl: WASM_URL, dialect: 'american' }, 30000)
  .catch((err) => {
    console.error('[Tasve] engine failed to initialise:', err.message);
    throw err;
  });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (request.action) {
        case 'lint':
          await engineReady;
          sendResponse({ ok: true, issues: await callWorker('lint', { text: request.text }) });
          break;

        case 'enginePing':
          await engineReady;
          sendResponse({ ok: true, ready: true });
          break;

        default:
          sendResponse({ ok: false, error: `Unknown offscreen action: ${request.action}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
