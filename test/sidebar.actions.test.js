/* =========================================================
   Guards the write-action buttons.

   Reported symptom: "clicked on summarize, still the button in
   improve, summarize button not clickable." Summarize was in fact
   running — the highlight was hardcoded on Improve in the HTML and
   no action ever changed it, so nothing indicated a click had
   registered.
   ========================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../sidebar.html', import.meta.url), 'utf8');
const JS = fs.readFileSync(new URL('../sidebar.js', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../sidebar.css', import.meta.url), 'utf8');

test('no write action is hardcoded as the highlighted one', () => {
  const block = HTML.slice(HTML.indexOf('primary-actions'), HTML.indexOf('write-result'));
  const hardcoded = [...block.matchAll(/<button id="(btn-[a-z]+)"[^>]*class="[^"]*\bprimary\b/g)]
    .map((m) => m[1]);
  assert.deepEqual(
    hardcoded,
    [],
    `${hardcoded.join(', ')} is highlighted in the HTML, so it looks selected no matter what ran`
  );
});

test('the highlight is applied from script, following the last action', () => {
  assert.match(
    JS,
    /classList\.toggle\('primary',\s*btn === button\)/,
    'expected the primary class to move to the button that was used'
  );
});

test('both actions are disabled while one is working', () => {
  assert.match(JS, /function setActionsBusy/);
  assert.match(JS, /btn\.disabled = busy/, 'buttons must be disabled during work');
  assert.match(JS, /aria-busy/, 'the working button should expose aria-busy');
});

test('every write action routes through the shared runner', () => {
  for (const button of ['btnGrammar', 'btnSummarize']) {
    assert.match(
      JS,
      new RegExp(`runAction\\(${button}`),
      `${button} does not go through runAction, so its state will not reset`
    );
  }
});

test('the spinner is cleared in a finally block', () => {
  // hideLoading used to sit after the try/catch, so an unexpected throw left
  // the spinner running forever.
  const runner = JS.slice(JS.indexOf('async function runAction'), JS.indexOf('// ── Grammar ──'));
  assert.match(runner, /finally\s*\{[\s\S]*hideLoading[\s\S]*setActionsBusy\(false\)/);
});

test('the disabled state is visible, not just functional', () => {
  assert.match(CSS, /\.action-btn:disabled/, 'a disabled button must look disabled');
});

test('the page-content fetch is awaited rather than fire-and-forget', () => {
  // The old path posted a message and set an 8s timeout, so runAction would
  // have cleared the spinner before the content arrived.
  assert.match(JS, /function requestPageContent/);
  assert.match(JS, /await requestPageContent\(\)/);
  assert.doesNotMatch(JS, /summarizeTimeoutId/, 'the old fire-and-forget timeout is still present');
});

test('summarize is allowed to run with an empty box, meaning "this page"', () => {
  assert.match(JS, /requireText: false/, 'summarize must not be blocked by the empty-text guard');
});

test('failures surface in the result area rather than being swallowed', () => {
  const runner = JS.slice(JS.indexOf('async function runAction'), JS.indexOf('// ── Grammar ──'));
  assert.match(runner, /catch \(err\)[\s\S]*showResult\('Error'/);
});
