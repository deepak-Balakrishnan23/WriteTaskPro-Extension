/* =========================================================
   Loads background.js the way the MV3 service worker does —
   as an ES module, against a chrome.* stub — and drives its real
   message handlers.

   Static syntax checks are not enough here. The defect that
   motivated this work (a ReferenceError in the inline grammar
   card) parsed perfectly and threw on every invocation.
   ========================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = { message: [], alarm: [], installed: [] };
const store = {};
const alarms = new Map();
const badge = {};

/* Records how the service worker talks to the offscreen engine host. */
const offscreen = {
  created: [],
  documents: [],
  requests: [],
  /* Set to make the fake engine fail, so the "reports the failure rather
     than claiming clean text" behaviour can be checked. */
  failWith: null,
  issues: []
};

function stubChrome() {
  const resolveOrCallback = (value, callback) => {
    if (typeof callback === 'function') {
      callback(value);
      return undefined;
    }
    return Promise.resolve(value);
  };

  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      getContexts: async () => offscreen.documents.map((url) => ({ documentUrl: url })),
      /* Stands in for the offscreen document's own onMessage handler. */
      sendMessage: async (message) => {
        if (message?.target !== 'offscreen') return undefined;
        offscreen.requests.push(message);
        if (offscreen.failWith) return { ok: false, error: offscreen.failWith };
        if (message.action === 'lint') return { ok: true, issues: offscreen.issues };
        if (message.action === 'enginePing') return { ok: true, ready: true };
        return { ok: false, error: `Unknown offscreen action: ${message.action}` };
      }
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING' },
      createDocument: async (options) => {
        if (offscreen.documents.length) throw new Error('Only a single offscreen document may be created');
        offscreen.created.push(options);
        offscreen.documents.push(`chrome-extension://test-extension-id/${options.url}`);
      },
      closeDocument: async () => { offscreen.documents.length = 0; }
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const names = Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const name of names) {
            if (name in store) result[name] = store[name];
          }
          return resolveOrCallback(result, callback);
        },
        set: (items, callback) => {
          Object.assign(store, items);
          return resolveOrCallback(undefined, callback);
        }
      }
    },
    contextMenus: {
      removeAll: (callback) => resolveOrCallback(undefined, callback),
      create: () => {},
      onClicked: { addListener: () => {} }
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      clear: (name) => { alarms.delete(name); return Promise.resolve(true); },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    action: {
      setBadgeBackgroundColor: (o) => { Object.assign(badge, o); return Promise.resolve(); },
      setBadgeTextColor: (o) => { Object.assign(badge, o); return Promise.resolve(); },
      setBadgeText: (o) => { Object.assign(badge, o); return Promise.resolve(); },
      setTitle: (o) => { Object.assign(badge, o); return Promise.resolve(); }
    },
    tabs: {
      query: (opts, callback) => resolveOrCallback([], callback),
      sendMessage: () => Promise.resolve()
    }
  };
}

stubChrome();
await import('../background.js');

/** Drives the real onMessage handler and resolves with its response. */
function send(request) {
  assert.ok(listeners.message.length > 0, 'background.js registered no message listener');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${request.action}`)), 5000);
    const kept = listeners.message[0](request, { id: 'test' }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    assert.equal(kept, true, 'handler must return true to keep the response channel open');
  });
}

/* ── The service worker loads at all ───────────────────────── */

test('background.js loads as an ES module and registers handlers', () => {
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.installed.length, 1);
  assert.equal(listeners.alarm.length, 1);
});

test('unknown actions are reported, not thrown', async () => {
  assert.deepEqual(await send({ action: 'nope' }), { error: 'Unknown action' });
});

/* ── Phase 1: grammar routes to the offscreen engine ──────────
   The regex checker is gone. checkGrammar must reach the engine
   host, and must report failure rather than returning [] — a
   silent empty result reads as "your text is clean".
   ───────────────────────────────────────────────────────────── */

test('checkGrammar creates the offscreen document and forwards the text', async () => {
  offscreen.issues = [
    {
      offset: 7,
      length: 4,
      ruleId: 'BoundaryError',
      severity: 'spelling',
      message: '`a lot` should be written as two words.',
      problemText: 'alot',
      replacements: [{ text: 'a lot', kind: 'replace' }]
    }
  ];

  const issues = await send({ action: 'checkGrammar', text: 'I want alot of pasta.' });

  assert.equal(offscreen.created.length, 1, 'offscreen document was not created');
  assert.equal(offscreen.created[0].url, 'offscreen.html');
  assert.deepEqual(offscreen.created[0].reasons, ['WORKERS']);
  assert.ok(offscreen.created[0].justification, 'a justification is required');

  const lintRequest = offscreen.requests.find((r) => r.action === 'lint');
  assert.equal(lintRequest.text, 'I want alot of pasta.');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].problemText, 'alot');
});

test('the offscreen document is reused, not recreated', async () => {
  const before = offscreen.created.length;
  await send({ action: 'checkGrammar', text: 'Another alot of text.' });
  assert.equal(offscreen.created.length, before, 'created a second offscreen document');
});

test('an engine failure is reported, not silently reported as clean text', async () => {
  offscreen.failWith = 'Grammar engine timed out on "lint"';
  const response = await send({ action: 'checkGrammar', text: 'I want alot of pasta.' });
  offscreen.failWith = null;

  assert.ok(response?.error, `expected an error, got ${JSON.stringify(response)}`);
  assert.match(response.error, /timed out/);
});

test('blank text short-circuits without waking the engine', async () => {
  const before = offscreen.requests.length;
  assert.deepEqual(await send({ action: 'checkGrammar', text: '   ' }), []);
  assert.equal(offscreen.requests.length, before, 'woke the engine for empty input');
});

test('messages addressed to the offscreen host are ignored by the service worker', () => {
  const kept = listeners.message[0]({ target: 'offscreen', action: 'lint', text: 'x' }, {}, () => {
    throw new Error('the service worker answered a message meant for the offscreen host');
  });
  assert.equal(kept, false, 'must return false so the real host can respond');
});

test('engineStatus reports readiness', async () => {
  assert.deepEqual(await send({ action: 'engineStatus' }), { ready: true });
});

/* ── Removed surfaces are actually gone ────────────────────── */

test('the writing score handler is removed', async () => {
  const response = await send({ action: 'writingScore', text: 'Some text here.' });
  assert.deepEqual(response, { error: 'Unknown action' }, 'writingScore should no longer exist');
});

test('the humanize handler is removed', async () => {
  const response = await send({ action: 'analyzeHumanizeText', text: 'Some text here.' });
  assert.deepEqual(response, { error: 'Unknown action' });
});

/* ── Paragraph preservation, end to end ────────────────────── */

test('fixGrammar preserves paragraph breaks', async () => {
  const source = 'the first paragraph needs work.\n\nthe second paragraph should survive.';
  const result = await send({ action: 'fixGrammar', text: source });
  assert.ok(
    result.includes('\n\n'),
    `paragraph break was flattened:\n${JSON.stringify(result)}`
  );
});

test('paraphrase preserves paragraph breaks in every mode', async () => {
  const source = 'we cannot ship this today.\n\nit is not ready for review.';
  for (const mode of ['standard', 'formal', 'casual', 'shorten', 'expand', 'creative']) {
    const result = await send({ action: 'paraphrase', text: source, mode });
    assert.ok(
      result.includes('\n\n'),
      `mode "${mode}" flattened the paragraph break:\n${JSON.stringify(result)}`
    );
  }
});

test('an unknown paraphrase mode falls back instead of returning empty', async () => {
  const result = await send({ action: 'paraphrase', text: 'we cannot ship this.', mode: 'bogus' });
  assert.ok(result && result.length > 0, 'unknown mode produced no output');
});

/* ── The summarizer reports the real figure ────────────────── */

test('summarize does not alter figures', async () => {
  const source = [
    'Quarterly Earnings Report',
    'The company reported revenue of 4.2 billion dollars for the quarter, exceeding expectations by nine percent.',
    'Operating margins compressed to 18 percent as infrastructure spending accelerated through the period.'
  ].join('\n');
  const summary = await send({ action: 'summarize', content: source });
  assert.match(summary, /4\.2 billion/, `figure was altered:\n${summary}`);
});

/* ── Degenerate input on every text handler ────────────────── */

test('text handlers survive empty, null and undefined input', async () => {
  for (const action of ['checkGrammar', 'fixGrammar', 'paraphrase']) {
    for (const text of ['', null, undefined, '   ']) {
      const response = await send({ action, text });
      assert.ok(
        response === '' || response === null || Array.isArray(response) || typeof response === 'string',
        `${action} returned something unusable for ${JSON.stringify(text)}: ${JSON.stringify(response)}`
      );
    }
  }
});

test('summarize survives empty input', async () => {
  const response = await send({ action: 'summarize', content: '' });
  assert.equal(typeof response, 'string');
  assert.ok(response.length > 0);
});

/* ── Task round-trip still works after the refactor ────────── */

test('a task can be created, listed and completed', async () => {
  const created = await send({
    action: 'createTask',
    task: { title: 'Write the spec', kind: 'task', priority: 'P2', durationMinutes: 30 }
  });
  assert.ok(created.id, 'createTask returned no id');
  assert.equal(created.completed, false);
  assert.ok(alarms.has(`task-reminder-${created.id}`), 'no reminder alarm was scheduled');

  const listed = await send({ action: 'getTasks' });
  assert.ok(listed.some((task) => task.id === created.id));

  await send({ action: 'completeTask', taskId: created.id });
  const afterComplete = await send({ action: 'getTasks' });
  assert.equal(afterComplete.find((task) => task.id === created.id).completed, true);
  assert.equal(alarms.has(`task-reminder-${created.id}`), false, 'alarm was not cleared');
});

test('deleting a task clears its alarm', async () => {
  const created = await send({
    action: 'createTask',
    task: { title: 'Temporary', kind: 'task', durationMinutes: 15 }
  });
  await send({ action: 'deleteTask', taskId: created.id });
  const listed = await send({ action: 'getTasks' });
  assert.equal(listed.some((task) => task.id === created.id), false);
  assert.equal(alarms.has(`task-reminder-${created.id}`), false);
});
