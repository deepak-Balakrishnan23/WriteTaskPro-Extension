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

/* Reminder routing: which tab was messaged, and whether the fallback
   window had to be opened. `activeTab` is what chrome.tabs.query returns,
   and sendFails simulates a tab with no content script in it yet. */
const routing = {
  activeTab: null,
  sendFails: false,
  sent: [],
  windows: []
};

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
      query: (opts, callback) => resolveOrCallback(routing.activeTab ? [routing.activeTab] : [], callback),
      sendMessage: (tabId, message) => {
        routing.sent.push({ tabId, message });
        /* A tab that has never been reloaded since install has no content
           script, and chrome rejects rather than silently dropping. */
        if (routing.sendFails) return Promise.reject(new Error('Receiving end does not exist'));
        return Promise.resolve();
      }
    },
    windows: {
      create: async (options) => { routing.windows.push(options); return { id: 1 }; }
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

/* ── Generative rewriting is gone, not disabled ────────────── */

test('the paraphrase handler is removed', async () => {
  const response = await send({ action: 'paraphrase', text: 'we cannot ship this.', mode: 'rewrite' });
  assert.deepEqual(response, { error: 'Unknown action' }, 'paraphrase should no longer exist');
});

test('the aiAvailability handler is removed', async () => {
  assert.deepEqual(await send({ action: 'aiAvailability' }), { error: 'Unknown action' });
});

test('nothing reaches the offscreen document for an AI prompt any more', async () => {
  offscreen.requests.length = 0;
  await send({ action: 'summarize', content: 'Some source text worth summarizing here. It has two sentences.' });
  assert.equal(
    offscreen.requests.filter((r) => r.action === 'aiPrompt' || r.action === 'aiAvailability').length,
    0,
    'the Gemini Nano plumbing is still being called'
  );
});

/* ── The summarizer reports the real figure ────────────────── */

test('summarize uses the extractive summarizer and does not alter figures', async () => {
  const source = [
    'Quarterly Earnings Report',
    'The company reported revenue of 4.2 billion dollars for the quarter, exceeding expectations by nine percent.',
    'Operating margins compressed to 18 percent as infrastructure spending accelerated through the period.'
  ].join('\n');
  const summary = await send({ action: 'summarize', content: source });
  assert.match(summary, /4\.2 billion/, `figure was altered:\n${summary}`);
});

/* ── Immersive reminder routing ─────────────────────────────── */

/** Fires the alarm for a task that exists in storage. */
async function fireReminder(task) {
  routing.sent.length = 0;
  routing.windows.length = 0;
  store.wtp_tasks = [{ id: 'r1', title: 'Drink water', kind: 'water', completed: false, ...task }];
  await listeners.alarm[0]({ name: `task-reminder-${task.id || 'r1'}` });
  /* routeReminder awaits storage and tabs, so let those microtasks drain. */
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a reminder goes to the active http tab, not every tab', async () => {
  routing.activeTab = { id: 7, url: 'https://example.com/article' };
  routing.sendFails = false;
  await fireReminder({ id: 'r1' });

  const overlayMessages = routing.sent.filter((s) => s.message.action === 'showReminderOverlay');
  assert.equal(overlayMessages.length, 1, 'exactly one tab should be asked to show the overlay');
  assert.equal(overlayMessages[0].tabId, 7);
  assert.equal(routing.windows.length, 0, 'no fallback window is needed when a tab worked');
});

test('the payload carries the kind and the user wording separately', async () => {
  routing.activeTab = { id: 7, url: 'https://example.com/' };
  routing.sendFails = false;
  await fireReminder({ id: 'r1', kind: 'water', title: 'Finish the 1L bottle' });

  const { task } = routing.sent.find((s) => s.message.action === 'showReminderOverlay').message;
  assert.equal(task.kind, 'water');
  assert.equal(task.taskTitle, 'Finish the 1L bottle', 'the overlay needs the raw title for its message');
  assert.match(task.title, /^Tasve/, 'the notification title keeps its prefix');
});

test('a chrome:// page falls back to the reminder window', async () => {
  routing.activeTab = { id: 9, url: 'chrome://settings' };
  routing.sendFails = false;
  await fireReminder({ id: 'r1' });

  assert.equal(routing.sent.filter((s) => s.message.action === 'showReminderOverlay').length, 0);
  assert.equal(routing.windows.length, 1, 'an uninjectable tab must still produce a reminder');
  assert.match(routing.windows[0].url, /reminder\.html\?id=r1/);
  assert.equal(routing.windows[0].type, 'popup');
});

test('no open window at all falls back to the reminder window', async () => {
  routing.activeTab = null;
  await fireReminder({ id: 'r1' });
  assert.equal(routing.windows.length, 1);
});

test('a tab with no content script falls back rather than losing the reminder', async () => {
  routing.activeTab = { id: 11, url: 'https://example.com/' };
  routing.sendFails = true;
  await fireReminder({ id: 'r1' });
  routing.sendFails = false;

  assert.equal(routing.windows.length, 1, 'a rejected sendMessage must fall through to the window');
});

test('fullscreenReminders off restores the badge-only behaviour', async () => {
  store.wtp_settings = { fullscreenReminders: false };
  routing.activeTab = { id: 7, url: 'https://example.com/' };
  await fireReminder({ id: 'r1' });
  delete store.wtp_settings;

  assert.equal(routing.sent.filter((s) => s.message.action === 'showReminderOverlay').length, 0);
  assert.equal(routing.windows.length, 0);
  /* The reminder itself is untouched — only its presentation changed. */
  assert.equal(store.wtp_tasks[0].attentionNeeded, true);
  assert.ok(badge.text, 'the badge must still report it');
});

test('the reminder is recorded before it is routed, so nothing depends on the overlay', async () => {
  routing.activeTab = null;
  await fireReminder({ id: 'r1' });
  assert.equal(store.wtp_tasks[0].attentionNeeded, true);
});

/* ── Done, from the overlay ─────────────────────────────────── */

test('Done completes a one-off reminder', async () => {
  store.wtp_tasks = [{ id: 'r2', title: 'Send invoice', kind: 'task', completed: false, attentionNeeded: true }];
  await send({ action: 'resolveReminder', taskId: 'r2' });
  assert.equal(store.wtp_tasks[0].completed, true);
});

test('Done on a recurring ritual clears attention without killing the recurrence', async () => {
  /* Completing a recurring water reminder would end every future one. */
  store.wtp_tasks = [{
    id: 'r3', title: 'Drink water', kind: 'water', completed: false,
    attentionNeeded: true, recurring: true
  }];
  await send({ action: 'resolveReminder', taskId: 'r3' });

  assert.equal(store.wtp_tasks[0].completed, false, 'a recurring ritual must not be completed');
  assert.equal(store.wtp_tasks[0].attentionNeeded, false, 'but its attention flag must clear');
});

test('resolveReminder on a missing task is a no-op, not a throw', async () => {
  store.wtp_tasks = [];
  assert.equal(await send({ action: 'resolveReminder', taskId: 'gone' }), true);
});

test('getReminderTask returns the payload the window needs, or null', async () => {
  store.wtp_tasks = [{ id: 'r4', title: 'Tea', kind: 'tea', completed: false }];
  const payload = await send({ action: 'getReminderTask', taskId: 'r4' });
  assert.equal(payload.kind, 'tea');
  assert.equal(payload.taskTitle, 'Tea');
  assert.equal(await send({ action: 'getReminderTask', taskId: 'nope' }), null);
});

/* ── Degenerate input on every text handler ────────────────── */

test('text handlers survive empty, null and undefined input', async () => {
  for (const action of ['checkGrammar']) {
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
