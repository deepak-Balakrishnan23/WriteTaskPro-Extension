import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBriefSummary } from '../lib/summarize.js';

const EARNINGS = [
  'Quarterly Earnings Report',
  'The company reported revenue of 4.2 billion dollars for the quarter, exceeding analyst expectations by nearly nine percent.',
  'Operating margins compressed to 18 percent as cloud infrastructure spending accelerated ahead of the planned datacenter expansion.',
  'Management guided full year revenue to a range of 17 to 18 billion dollars and announced a share repurchase authorization.'
].join('\n');

/* ── The figure-corruption regression ─────────────────────────
   Old output: "Quarterly Earnings Report: 2 billion dollars for
   the quarter, exceeding analyst expectations by nearly nine
   percent." — the sentence splitter broke "4.2" apart and a
   word-count filter discarded the half holding "4".
   ───────────────────────────────────────────────────────────── */

test('reports the correct figure', () => {
  const summary = buildBriefSummary(EARNINGS);
  assert.match(summary, /4\.2 billion/, `figure was altered:\n${summary}`);
  assert.doesNotMatch(
    summary,
    /(^|[^.\d])2 billion/,
    `summary contains a corrupted figure:\n${summary}`
  );
});

test('every figure in the summary appears in the source', () => {
  const summary = buildBriefSummary(EARNINGS);
  const sourceNumbers = new Set(EARNINGS.match(/\d+(?:\.\d+)?/g) || []);
  for (const number of summary.match(/\d+(?:\.\d+)?/g) || []) {
    assert.ok(
      sourceNumbers.has(number),
      `summary invented the number ${number}:\n${summary}`
    );
  }
});

/* ── No mid-sentence truncation ───────────────────────────────
   A clipped sentence can reverse its own meaning, so a sentence
   is included whole or not at all.
   ───────────────────────────────────────────────────────────── */

test('never emits a truncated sentence', () => {
  const summary = buildBriefSummary(EARNINGS);
  assert.doesNotMatch(summary, /\.\.\./, `summary truncated a sentence:\n${summary}`);
});

test('does not clip a contrastive clause and invert the meaning', () => {
  const source = [
    'Performance Review',
    'Revenue grew forty percent year over year but gross margins collapsed to single digits and the board has paused hiring.',
    'The finance team expects the shortfall to persist through the next two quarters unless pricing changes.'
  ].join('\n');
  const summary = buildBriefSummary(source);
  // If the contrastive sentence appears at all, it must keep its "but" clause.
  if (/Revenue grew forty percent/.test(summary)) {
    assert.match(summary, /but gross margins collapsed/, `meaning was inverted:\n${summary}`);
  }
});

test('each summary sentence appears in the source, whole', () => {
  const summary = buildBriefSummary(EARNINGS);
  const body = EARNINGS.toLowerCase();
  const lines = summary.split('\n').slice(1); // bullets only; the intro is reformatted
  for (const line of lines) {
    const claim = line.replace(/^•\s*/, '').replace(/[.!?]+$/, '').toLowerCase();
    assert.ok(body.includes(claim), `bullet is not a verbatim source sentence:\n${claim}`);
  }
});

/* ── No topic bias ────────────────────────────────────────────
   The old scorer added +3 for sports vocabulary, so identical
   prose scored differently by subject.
   ───────────────────────────────────────────────────────────── */

test('does not favour sports vocabulary over other subjects', () => {
  const shell = (filler) => [
    'Weekly Update',
    `The team confirmed that ${filler} would continue through the end of the current reporting period without further changes.`,
    'A second unrelated sentence describes the procurement timeline and the vendors under active consideration this month.',
    'A third sentence records the budget variance and the mitigation steps agreed by the steering committee last Thursday.'
  ].join('\n');

  const sports = buildBriefSummary(shell('the injury and the captain rotation for the season'));
  const finance = buildBriefSummary(shell('the depreciation schedule and the vendor rotation for the period'));

  // Both should select the same positional sentences, so the shapes match.
  assert.equal(
    sports.split('\n').length,
    finance.split('\n').length,
    'topic changed how many sentences were selected'
  );
});

/* ── Degenerate input ─────────────────────────────────────────── */

test('handles empty and unreadable input without throwing', () => {
  assert.equal(buildBriefSummary(''), 'No readable content found.');
  assert.equal(buildBriefSummary(null), 'No readable content found.');
  assert.equal(buildBriefSummary(undefined), 'No readable content found.');
  assert.equal(buildBriefSummary('   \n\n  '), 'No readable content found.');
});

test('strips boilerplate lines', () => {
  const summary = buildBriefSummary([
    'Advertisement',
    'Subscribe',
    'The migration completed successfully after the team resolved the outstanding schema conflicts on Tuesday afternoon.'
  ].join('\n'));
  assert.doesNotMatch(summary, /Advertisement|Subscribe/i);
});

test('does not throw on very short content', () => {
  assert.doesNotThrow(() => buildBriefSummary('Too short.'));
});
