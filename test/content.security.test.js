/* =========================================================
   Tests the real functions in content.js by extracting them
   from the shipped source, so these cannot drift from what
   actually runs. content.js is an IIFE that needs a DOM, so
   the pure functions are lifted out and given a scope.
   ========================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');

/* Comments discuss the very patterns these tests ban, so scans that look
   for code smells must run against code only. */
const CODE_ONLY = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function extractFunction(name) {
  const match = SOURCE.match(new RegExp(`^  function ${name}\\([\\s\\S]*?\\n  \\}`, 'm'));
  assert.ok(match, `could not extract ${name}() from content.js`);
  return match[0];
}

/* Rebuild the closure the extracted functions expect. */
function build({ sidebarFrame = null, extensionOrigin = null } = {}) {
  const factory = new Function(
    'sidebarFrame',
    'EXTENSION_ORIGIN',
    'Node',
    `${extractFunction('escapeHTML')}
     ${extractFunction('isTrustedSidebarMessage')}
     ${extractFunction('hasRichContent')}
     return { escapeHTML, isTrustedSidebarMessage, hasRichContent };`
  );
  return factory(sidebarFrame, extensionOrigin, { ELEMENT_NODE: 1, TEXT_NODE: 3 });
}

/* ── F-01: escapeHTML must exist and work ─────────────────────
   It was referenced in showGrammarCard but never declared, so
   every call threw ReferenceError and a bare catch swallowed it.
   The inline grammar card never rendered once.
   ───────────────────────────────────────────────────────────── */

test('escapeHTML is defined in content.js', () => {
  assert.match(SOURCE, /function escapeHTML\(/, 'escapeHTML is missing from content.js');
});

test('escapeHTML neutralises markup', () => {
  const { escapeHTML } = build();
  assert.equal(
    escapeHTML('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
  assert.equal(escapeHTML("it's & <b>"), 'it&#39;s &amp; &lt;b&gt;');
});

test('escapeHTML escapes the ampersand first, avoiding double-encoding bugs', () => {
  const { escapeHTML } = build();
  assert.equal(escapeHTML('&lt;'), '&amp;lt;');
});

test('escapeHTML handles null, undefined and non-strings', () => {
  const { escapeHTML } = build();
  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
  assert.equal(escapeHTML(0), '0');
  assert.equal(escapeHTML(false), 'false');
});

test('every escapeHTML call site in showGrammarCard now resolves', () => {
  const { escapeHTML } = build();
  // Mirrors the two interpolations in showGrammarCard.
  const issue = { rule: 'Spelling', replacement: 'a lot', suggestion: '' };
  assert.doesNotThrow(() => {
    `${escapeHTML(issue.rule || 'Grammar suggestion')}`;
    `${escapeHTML(issue.replacement || issue.suggestion || '')}`;
  });
});

/* ── F-05: the postMessage channel must be authenticated ──────
   Any page could post {source:'wtp-sidebar', action:'replaceSelection'}
   to its own window and have text written into the user's editor.
   ───────────────────────────────────────────────────────────── */

const ORIGIN = 'chrome-extension://test-extension-id';

test('rejects a spoofed message from the host page', () => {
  const frameWindow = { name: 'sidebar' };
  const { isTrustedSidebarMessage } = build({
    sidebarFrame: { contentWindow: frameWindow },
    extensionOrigin: ORIGIN
  });

  const spoofed = {
    source: { name: 'hostile page' },
    origin: 'https://evil.example',
    data: { source: 'wtp-sidebar', action: 'replaceSelection', text: 'malicious' }
  };
  assert.equal(isTrustedSidebarMessage(spoofed), false, 'spoofed message was trusted');
});

test('rejects a message from the page even when the origin string is faked', () => {
  const frameWindow = { name: 'sidebar' };
  const { isTrustedSidebarMessage } = build({
    sidebarFrame: { contentWindow: frameWindow },
    extensionOrigin: ORIGIN
  });

  // event.origin is set by the browser, but assert that source alone is decisive.
  assert.equal(
    isTrustedSidebarMessage({
      source: { name: 'hostile page' },
      origin: ORIGIN,
      data: { source: 'wtp-sidebar', action: 'replaceSelection', text: 'x' }
    }),
    false,
    'a wrong source window was accepted because the origin matched'
  );
});

test('rejects the right window at the wrong origin', () => {
  const frameWindow = { name: 'sidebar' };
  const { isTrustedSidebarMessage } = build({
    sidebarFrame: { contentWindow: frameWindow },
    extensionOrigin: ORIGIN
  });
  assert.equal(
    isTrustedSidebarMessage({
      source: frameWindow,
      origin: 'https://evil.example',
      data: { source: 'wtp-sidebar', action: 'closeSidebar' }
    }),
    false
  );
});

test('accepts a genuine message from the sidebar iframe', () => {
  const frameWindow = { name: 'sidebar' };
  const { isTrustedSidebarMessage } = build({
    sidebarFrame: { contentWindow: frameWindow },
    extensionOrigin: ORIGIN
  });
  assert.equal(
    isTrustedSidebarMessage({
      source: frameWindow,
      origin: ORIGIN,
      data: { source: 'wtp-sidebar', action: 'closeSidebar' }
    }),
    true,
    'a legitimate sidebar message was rejected'
  );
});

test('rejects everything before the sidebar frame exists', () => {
  const { isTrustedSidebarMessage } = build({ sidebarFrame: null, extensionOrigin: ORIGIN });
  assert.equal(
    isTrustedSidebarMessage({
      source: {},
      origin: ORIGIN,
      data: { source: 'wtp-sidebar', action: 'replaceSelection', text: 'x' }
    }),
    false
  );
});

test('rejects a trusted window carrying an unrelated payload', () => {
  const frameWindow = { name: 'sidebar' };
  const { isTrustedSidebarMessage } = build({
    sidebarFrame: { contentWindow: frameWindow },
    extensionOrigin: ORIGIN
  });
  assert.equal(
    isTrustedSidebarMessage({ source: frameWindow, origin: ORIGIN, data: { source: 'something-else' } }),
    false
  );
  assert.equal(
    isTrustedSidebarMessage({ source: frameWindow, origin: ORIGIN, data: null }),
    false
  );
});

test('no postMessage to the sidebar uses a wildcard target origin', () => {
  // '*' would hand the host page a copy of everything we send our own iframe.
  const wildcardSends = CODE_ONLY.match(/contentWindow\.postMessage\([^)]*'\*'\s*\)/g) || [];
  assert.deepEqual(
    wildcardSends,
    [],
    `found unconditional wildcard postMessage: ${wildcardSends.join(', ')}`
  );
});

/* ── F-09: refuse rather than destroy formatting ────────────── */

test('hasRichContent detects markup that must not be destroyed', () => {
  const { hasRichContent } = build();
  const withLink = {
    isContentEditable: true,
    childNodes: [{ nodeType: 3, nodeName: '#text' }, { nodeType: 1, nodeName: 'A' }]
  };
  assert.equal(hasRichContent(withLink), true);
});

test('hasRichContent treats a plain text field as safe', () => {
  const { hasRichContent } = build();
  const plain = { isContentEditable: true, childNodes: [{ nodeType: 3, nodeName: '#text' }] };
  assert.equal(hasRichContent(plain), false);
});

test('hasRichContent ignores a bare line break', () => {
  const { hasRichContent } = build();
  const withBreak = {
    isContentEditable: true,
    childNodes: [{ nodeType: 3, nodeName: '#text' }, { nodeType: 1, nodeName: 'BR' }]
  };
  assert.equal(hasRichContent(withBreak), false, 'a <br> is not formatting worth refusing over');
});

test('hasRichContent is false for non-editable and missing elements', () => {
  const { hasRichContent } = build();
  assert.equal(hasRichContent(null), false);
  assert.equal(hasRichContent(undefined), false);
  assert.equal(hasRichContent({ isContentEditable: false, childNodes: [] }), false);
});

/* ── Silent failure is what let F-01 survive ────────────────── */

/* ── Duplication guard ────────────────────────────────────────
   content.js cannot import ES modules, so it carries its own copy
   of the staleness check. Two copies of a safety check that drift
   apart is worse than one, so assert they agree.
   ───────────────────────────────────────────────────────────── */

test('content.js staleness check matches lib/issues.js exactly', async () => {
  const { isIssueStale: libVersion } = await import('../lib/issues.js');
  const contentVersion = new Function(`${extractFunction('isIssueStale')} return isIssueStale;`)();

  const issue = { offset: 7, length: 4, problemText: 'alot' };
  const cases = [
    ['I want alot of pasta.', issue],
    ['I want lots of pasta.', issue],
    ['I want', issue],
    ['Actually I want alot of pasta.', issue],
    ['', issue],
    ['I want alot of pasta.', { offset: 7, length: 4, problemText: '' }],
    ['I want alot of pasta.', { offset: -1, length: 4, problemText: 'alot' }],
    ['I want alot of pasta.', { offset: 18, length: 40, problemText: 'alot' }],
    [null, issue],
    [undefined, issue],
    ['I want alot of pasta.', null],
    ['I want alot of pasta.', undefined]
  ];

  for (const [text, candidate] of cases) {
    assert.equal(
      contentVersion(text, candidate),
      libVersion(text, candidate),
      `divergence on ${JSON.stringify(text)} / ${JSON.stringify(candidate)}`
    );
  }
});

test('the whole-field replacement path is gone', () => {
  // el.innerText = text destroyed every link, list and bold run in the field.
  assert.doesNotMatch(CODE_ONLY, /\.innerText\s*=/, 'innerText assignment is back');
  assert.doesNotMatch(CODE_ONLY, /function setEditableText/, 'setEditableText is back');
});

test('suggestions are applied through a span-scoped API', () => {
  assert.match(CODE_ONLY, /setRangeText\(/, 'expected setRangeText for inputs, which preserves native undo');
  assert.match(CODE_ONLY, /function applyIssueToField/);
});

test('the floating button is a real button, not a div', () => {
  assert.match(
    CODE_ONLY,
    /createElement\('button'\)[\s\S]{0,200}wtp-fab/,
    'the FAB must be a <button> to be reachable by keyboard'
  );
  assert.match(CODE_ONLY, /aria-label',\s*'Open WriteTask Pro'/);
});

test('the grammar card is reachable and dismissible by keyboard', () => {
  assert.match(CODE_ONLY, /role',\s*'dialog'/, 'card needs a dialog role');
  assert.match(CODE_ONLY, /\.focus\(\)/, 'focus must move into the card');
  assert.match(CODE_ONLY, /key === 'Escape'/, 'Escape must close the card');
});

test('content.js has no bare catch blocks left', () => {
  const bare = CODE_ONLY.match(/catch\s*\{\s*\}/g) || [];
  assert.deepEqual(bare, [], `bare catch blocks remain: ${bare.length}`);
});

test('the misleading "ALL BUGS FIXED" banner is gone', () => {
  assert.doesNotMatch(SOURCE, /ALL BUGS FIXED/);
});
