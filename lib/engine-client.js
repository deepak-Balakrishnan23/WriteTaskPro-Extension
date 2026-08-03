/* =========================================================
   WriteTask Pro — Engine client (service worker side)

   Creates the offscreen document on demand and forwards lint
   requests to it. Chrome allows an extension only one offscreen
   document at a time, and createDocument() rejects if one already
   exists — including one left over from a previous service worker
   lifetime, since the document outlives the worker that made it.
   So creation is both guarded and serialised.
   ========================================================= */

const OFFSCREEN_PATH = 'offscreen.html';

/* Concurrent callers must not race to create the document; they all
   await the same in-flight promise. */
let creating = null;

async function hasDocument() {
  // getContexts is the supported check from Chrome 116 on.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  }
  return false;
}

export async function ensureEngine() {
  if (await hasDocument()) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        // The document hosts a module worker holding the WASM engine.
        // WORKERS is the accurate reason; unlike AUDIO_PLAYBACK it
        // carries no automatic 30-second teardown.
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Runs the local grammar engine in a worker so checking survives service worker shutdown.'
      })
      .catch((err) => {
        // A parallel creation may have won the race; that is not an error.
        if (!/already/i.test(err?.message || '')) throw err;
      })
      .finally(() => { creating = null; });
  }

  await creating;
}

/**
 * Lint text and return contract issues.
 * Throws with a readable message if the engine is unavailable, so callers
 * can surface that instead of silently reporting clean text — reporting
 * "no issues" when the engine never ran is the failure mode that made the
 * previous version untrustworthy.
 */
export async function lintText(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  await ensureEngine();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'lint',
    text: source
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Grammar engine unavailable');
  }

  return response.issues || [];
}

export async function engineReady() {
  await ensureEngine();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'enginePing' });
  return Boolean(response?.ok);
}
