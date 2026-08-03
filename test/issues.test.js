import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITY,
  REPLACEMENT_KIND,
  replacementKindName,
  severityForKind,
  makeIssue,
  isIssueStale,
  applyIssue,
  sortIssues,
  dropOverlapping
} from '../lib/issues.js';

/* ── The contract shape ───────────────────────────────────────
   F-06: the old contract had no positions, which made inline
   marks impossible. Every field below is load-bearing.
   ───────────────────────────────────────────────────────────── */

const TEXT = 'I want alot of pasta.';

function alotIssue(sourceText = TEXT) {
  return makeIssue(
    {
      start: 7,
      end: 11,
      kind: 'BoundaryError',
      message: '`a lot` should be written as two words.',
      suggestions: [{ kind: 0, text: 'a lot' }]
    },
    sourceText
  );
}

test('makeIssue produces the full contract', () => {
  const issue = alotIssue();
  assert.deepEqual(issue, {
    offset: 7,
    length: 4,
    ruleId: 'BoundaryError',
    severity: SEVERITY.SPELLING,
    message: '`a lot` should be written as two words.',
    problemText: 'alot',
    replacements: [{ text: 'a lot', kind: REPLACEMENT_KIND.REPLACE }]
  });
});

test('offset and length address the flagged span exactly', () => {
  const issue = alotIssue();
  assert.equal(TEXT.slice(issue.offset, issue.offset + issue.length), 'alot');
});

test('makeIssue rejects unusable spans instead of throwing', () => {
  const base = { kind: 'Spelling', message: 'x', suggestions: [] };
  assert.equal(makeIssue({ ...base, start: 5, end: 5 }, TEXT), null, 'zero-length span');
  assert.equal(makeIssue({ ...base, start: 9, end: 4 }, TEXT), null, 'inverted span');
  assert.equal(makeIssue({ ...base, start: -1, end: 3 }, TEXT), null, 'negative start');
  assert.equal(makeIssue({ ...base, start: 0, end: 999 }, TEXT), null, 'span past end of text');
  assert.equal(makeIssue({ ...base, start: 1.5, end: 3 }, TEXT), null, 'non-integer offset');
});

test('makeIssue drops duplicate replacements that differ only by whitespace', () => {
  // Harper emits both "They're" and "They're " for the same correction.
  const issue = makeIssue(
    {
      start: 0,
      end: 5,
      kind: 'Grammar',
      message: 'x',
      suggestions: [{ kind: 0, text: "They're" }, { kind: 0, text: "They're " }]
    },
    'Their going to lose.'
  );
  assert.equal(issue.replacements.length, 1);
});

test('severity maps the kinds the UI colours by', () => {
  assert.equal(severityForKind('Spelling'), SEVERITY.SPELLING);
  assert.equal(severityForKind('Grammar'), SEVERITY.GRAMMAR);
  assert.equal(severityForKind('WordChoice'), SEVERITY.STYLE);
  assert.equal(severityForKind(undefined), SEVERITY.STYLE, 'unknown kinds must not throw');
});

test('replacement kinds map from Harper’s numeric enum', () => {
  assert.equal(replacementKindName(0), REPLACEMENT_KIND.REPLACE);
  assert.equal(replacementKindName(1), REPLACEMENT_KIND.REMOVE);
  assert.equal(replacementKindName(2), REPLACEMENT_KIND.INSERT_AFTER);
  assert.equal(replacementKindName(99), REPLACEMENT_KIND.REPLACE, 'unknown kind falls back safely');
});

/* ── Offset-scoped application ────────────────────────────────
   F-09: this is what replaces "overwrite the whole field".
   ───────────────────────────────────────────────────────────── */

test('applying a suggestion changes only the flagged span', () => {
  assert.equal(applyIssue(TEXT, alotIssue()), 'I want a lot of pasta.');
});

test('applying leaves surrounding text byte-identical', () => {
  const result = applyIssue(TEXT, alotIssue());
  assert.equal(result.slice(0, 7), TEXT.slice(0, 7));
  assert.equal(result.slice(-10), TEXT.slice(-10));
});

test('a remove suggestion closes the gap it leaves', () => {
  const text = 'This is very very good.';
  const issue = makeIssue(
    { start: 13, end: 18, kind: 'Repetition', message: 'x', suggestions: [{ kind: 1, text: '' }] },
    text
  );
  assert.equal(applyIssue(text, issue), 'This is very good.');
});

test('an insertAfter suggestion keeps the original text', () => {
  const text = 'I dont know';
  const issue = makeIssue(
    { start: 2, end: 6, kind: 'Punctuation', message: 'x', suggestions: [{ kind: 2, text: '!' }] },
    text
  );
  assert.equal(applyIssue(text, issue), 'I dont! know');
});

test('a second replacement can be chosen', () => {
  const text = "Their going to lose.";
  const issue = makeIssue(
    {
      start: 0,
      end: 5,
      kind: 'Grammar',
      message: 'x',
      suggestions: [{ kind: 0, text: "They're" }, { kind: 0, text: 'There' }]
    },
    text
  );
  assert.equal(applyIssue(text, issue, 1), 'There going to lose.');
});

test('applyIssue returns null when there is no such replacement', () => {
  assert.equal(applyIssue(TEXT, alotIssue(), 7), null);
});

/* ── Emoji: the bug the docstring would have caused ───────────
   Harper documents its spans as "character indices". They are
   UTF-16 code units. Treating them as codepoints shifts every
   offset after an emoji.
   ───────────────────────────────────────────────────────────── */

test('offsets survive astral-plane characters', () => {
  const text = 'I love 🎉🎉 pizza and alot of pasta.';
  const start = text.indexOf('alot');
  const issue = makeIssue(
    { start, end: start + 4, kind: 'BoundaryError', message: 'x', suggestions: [{ kind: 0, text: 'a lot' }] },
    text
  );
  assert.equal(issue.problemText, 'alot');
  assert.equal(applyIssue(text, issue), 'I love 🎉🎉 pizza and a lot of pasta.');
});

test('an emoji inside the flagged span is preserved', () => {
  const text = 'wow🎉wow repeated';
  const issue = makeIssue(
    { start: 0, end: 8, kind: 'Repetition', message: 'x', suggestions: [{ kind: 0, text: 'wow' }] },
    text
  );
  assert.equal(issue.problemText, 'wow🎉wow');
  assert.equal(applyIssue(text, issue), 'wow repeated');
});

/* ── Staleness: the guard against corrupting unrelated text ───
   The user keeps typing while a check is in flight, so offsets
   go out of date constantly.
   ───────────────────────────────────────────────────────────── */

test('an issue is stale once the text under it changes', () => {
  const issue = alotIssue();
  assert.equal(isIssueStale(TEXT, issue), false);
  assert.equal(isIssueStale('I want lots of pasta.', issue), true);
});

test('an issue is stale when the text shrinks past its span', () => {
  assert.equal(isIssueStale('I want', alotIssue()), true);
});

test('a stale issue is refused rather than applied to the wrong text', () => {
  const issue = alotIssue();
  const edited = 'Actually I want alot of pasta.'; // text shifted right
  assert.equal(applyIssue(edited, issue), null, 'applied a stale issue and corrupted the text');
});

test('isIssueStale is defensive about bad input', () => {
  assert.equal(isIssueStale(null, alotIssue()), true);
  assert.equal(isIssueStale(TEXT, null), true);
  assert.equal(isIssueStale(TEXT, undefined), true);
});

/* ── Ordering and overlap ─────────────────────────────────────── */

test('issues sort into reading order', () => {
  const mk = (start, end) => ({ offset: start, length: end - start });
  const sorted = sortIssues([mk(20, 24), mk(0, 5), mk(7, 11)]);
  assert.deepEqual(sorted.map((i) => i.offset), [0, 7, 20]);
});

test('overlapping issues are reduced to one per span', () => {
  const mk = (offset, length) => ({ offset, length });
  const kept = dropOverlapping([mk(0, 10), mk(3, 4), mk(12, 3)]);
  assert.deepEqual(kept.map((i) => i.offset), [0, 12]);
});

test('adjacent but non-overlapping issues are both kept', () => {
  const kept = dropOverlapping([{ offset: 0, length: 5 }, { offset: 5, length: 5 }]);
  assert.equal(kept.length, 2);
});

test('every kept issue can be applied to the original text independently', () => {
  const text = 'Their going to loose the recieved data.';
  const raw = [
    { start: 0, end: 5, kind: 'Grammar', message: 'x', suggestions: [{ kind: 0, text: "They're" }] },
    { start: 15, end: 20, kind: 'Spelling', message: 'x', suggestions: [{ kind: 0, text: 'lose' }] },
    { start: 25, end: 33, kind: 'Spelling', message: 'x', suggestions: [{ kind: 0, text: 'received' }] }
  ];
  const issues = dropOverlapping(raw.map((r) => makeIssue(r, text)).filter(Boolean));
  assert.equal(issues.length, 3);
  for (const issue of issues) {
    assert.notEqual(applyIssue(text, issue), null, `could not apply ${issue.problemText}`);
  }
});
