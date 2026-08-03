/* =========================================================
   Drives the real Harper engine through the real issue contract.

   This is the test that decides whether Phase 1 worked. It uses
   the same normalization the worker uses, so a contract change
   that breaks Harper's output shows up here rather than in the
   browser.

   Cold start costs about half a second, so setup is shared.
   ========================================================= */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { LocalLinter, Dialect } from 'harper.js';
import { binary } from 'harper.js/binary';

import { makeIssue, dropOverlapping, applyIssue, isIssueStale, SEVERITY } from '../lib/issues.js';

let linter;

before(async () => {
  linter = new LocalLinter({ binary, dialect: Dialect.American });
  await linter.setup();
});

/** Mirrors engine/harper-worker.js toIssues(). */
async function check(text) {
  const lints = await linter.lint(text);
  const issues = lints
    .map((lint) => {
      const span = lint.span();
      return makeIssue(
        {
          start: span.start,
          end: span.end,
          kind: lint.lint_kind(),
          message: lint.message(),
          suggestions: lint.suggestions().map((s) => ({ kind: s.kind(), text: s.get_replacement_text() }))
        },
        text
      );
    })
    .filter(Boolean);
  return dropOverlapping(issues);
}

/* ── The audit's headline failure ──────────────────────────────
   The old engine found 0 issues here and scored it 100/100 for
   grammar.
   ───────────────────────────────────────────────────────────── */

const BROKEN = "Their going to loose they're minds when the data is recieved tommorow.";

test('catches the errors the old engine missed entirely', async () => {
  const issues = await check(BROKEN);
  assert.ok(issues.length >= 4, `expected at least 4 issues, got ${issues.length}`);

  const flagged = issues.map((i) => i.problemText);
  for (const word of ['Their', 'recieved', 'tommorow']) {
    assert.ok(
      flagged.some((text) => text.includes(word)),
      `did not flag "${word}"; flagged: ${JSON.stringify(flagged)}`
    );
  }
});

test('catches inflected misspellings, which the old table structurally could not', async () => {
  // \brecieve\b never matched "recieved" — the boundary failed on the 'd'.
  for (const word of ['recieved', 'seperated', 'occuring']) {
    const issues = await check(`The document was ${word} yesterday.`);
    assert.ok(
      issues.some((i) => i.problemText === word),
      `"${word}" was not flagged`
    );
  }
});

test('every issue points at exactly the text it flagged', async () => {
  const issues = await check(BROKEN);
  for (const issue of issues) {
    assert.equal(
      BROKEN.slice(issue.offset, issue.offset + issue.length),
      issue.problemText,
      `offset mismatch for ${JSON.stringify(issue)}`
    );
  }
});

test('every issue carries at least one usable replacement', async () => {
  const issues = await check(BROKEN);
  for (const issue of issues) {
    assert.ok(Array.isArray(issue.replacements));
    assert.ok(
      issue.replacements.length > 0,
      `no replacement offered for "${issue.problemText}"`
    );
    for (const replacement of issue.replacements) {
      assert.equal(typeof replacement.text, 'string');
      assert.ok(['replace', 'remove', 'insertAfter'].includes(replacement.kind));
    }
  }
});

test('applying a suggestion changes only that span', async () => {
  const text = 'I want alot of pasta.';
  const [issue] = await check(text);
  assert.ok(issue, 'expected "alot" to be flagged');
  const result = applyIssue(text, issue);
  assert.equal(result, 'I want a lot of pasta.');
});

test('applying every issue in reverse order fixes the sentence without corruption', async () => {
  const issues = await check(BROKEN);
  // Reverse order keeps earlier offsets valid as later text shifts.
  let text = BROKEN;
  for (const issue of [...issues].reverse()) {
    const next = applyIssue(text, issue);
    if (next !== null) text = next;
  }
  assert.match(text, /received/, `spelling not corrected:\n${text}`);
  assert.match(text, /tomorrow/, `spelling not corrected:\n${text}`);
  assert.doesNotMatch(text, /recieved|tommorow/, `original misspelling survived:\n${text}`);
});

/* ── Offsets under astral-plane characters ─────────────────────
   Harper documents spans as "character indices", which would imply
   codepoints. They are UTF-16 code units. If that were wrong, every
   offset after an emoji would be shifted.
   ───────────────────────────────────────────────────────────── */

test('offsets are UTF-16 code units, verified against the live engine', async () => {
  const text = 'I love 🎉🎉 pizza and alot of pasta.';
  const issues = await check(text);
  const alot = issues.find((i) => i.problemText === 'alot');
  assert.ok(alot, `emoji shifted the offsets; flagged: ${JSON.stringify(issues.map((i) => i.problemText))}`);
  assert.equal(applyIssue(text, alot), 'I love 🎉🎉 pizza and a lot of pasta.');
});

/* ── Clean text must stay clean ────────────────────────────────
   A checker that flags correct prose is worse than none.
   ───────────────────────────────────────────────────────────── */

test('does not flag correct prose', async () => {
  const clean = 'The quarterly report was published on Tuesday. It confirmed the revised forecast.';
  const issues = await check(clean);
  assert.deepEqual(
    issues.map((i) => `${i.problemText}: ${i.message}`),
    [],
    'flagged correct prose'
  );
});

test('does not break on decimals, initialisms or version strings', async () => {
  const text = 'Revenue hit $4.2B against the U.S. forecast of 3.9B in v1.2.3.';
  const issues = await check(text);
  for (const issue of issues) {
    assert.equal(isIssueStale(text, issue), false, `bad span on: ${issue.problemText}`);
  }
});

/* ── Severity, which the UI colours marks by ──────────────────── */

test('assigns a known severity to every issue', async () => {
  const issues = await check(BROKEN);
  const valid = new Set(Object.values(SEVERITY));
  for (const issue of issues) {
    assert.ok(valid.has(issue.severity), `unknown severity "${issue.severity}" for ${issue.ruleId}`);
  }
});

test('spelling mistakes are classified as spelling', async () => {
  const issues = await check('The data was recieved yesterday.');
  const issue = issues.find((i) => i.problemText === 'recieved');
  assert.equal(issue.severity, SEVERITY.SPELLING);
});

/* ── No overlapping marks ─────────────────────────────────────── */

test('no two issues cover the same characters', async () => {
  const issues = await check(BROKEN);
  for (let i = 1; i < issues.length; i += 1) {
    const previousEnd = issues[i - 1].offset + issues[i - 1].length;
    assert.ok(
      issues[i].offset >= previousEnd,
      `issues overlap: ${issues[i - 1].problemText} and ${issues[i].problemText}`
    );
  }
});

/* ── Long text stays within the latency budget ─────────────────── */

test('checks a 500-word document well inside the latency budget', async () => {
  const paragraph =
    'The quarterly review highlighted several risks that the team had not previously modelled, ' +
    'including vendor concentration and a currency exposure that widened after the last decision. ';
  const long = paragraph.repeat(18);
  const wordCount = long.trim().split(/\s+/).length;
  assert.ok(wordCount >= 450, `test text too short: ${wordCount} words`);

  await check(long); // warm
  const started = performance.now();
  await check(long);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)}ms on ${wordCount} words`);
});

test('empty and whitespace input produce no issues', async () => {
  assert.deepEqual(await check(''), []);
  assert.deepEqual(await check('   \n  '), []);
});
