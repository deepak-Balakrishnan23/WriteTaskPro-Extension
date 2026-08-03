import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupSpacing,
  normalizeWhitespace,
  normalizeInlineWhitespace,
  ensureTrailingPunctuation,
  countWords
} from '../lib/text.js';

/* ── cleanupSpacing must not corrupt numbers or abbreviations ──
   The original inserted a space after every period followed by a
   non-space character, which turned 4.2 into "4. 2". The broken
   sentence splitter hid this, because it had already shredded the
   number before cleanupSpacing ever saw it.
   ───────────────────────────────────────────────────────────── */

test('leaves decimals intact', () => {
  assert.equal(cleanupSpacing('Revenue of 4.2 billion'), 'Revenue of 4.2 billion');
  assert.equal(cleanupSpacing('Growth of 0.75 percent'), 'Growth of 0.75 percent');
});

test('leaves thousands separators intact', () => {
  assert.equal(cleanupSpacing('We shipped 1,000 units'), 'We shipped 1,000 units');
  assert.equal(cleanupSpacing('Costs hit 1,250,000 dollars'), 'Costs hit 1,250,000 dollars');
});

test('leaves version strings intact', () => {
  assert.equal(cleanupSpacing('Upgrade to v1.2.3 now'), 'Upgrade to v1.2.3 now');
});

test('leaves acronyms and abbreviations intact', () => {
  assert.equal(cleanupSpacing('The U.S. office'), 'The U.S. office');
  assert.equal(cleanupSpacing('Use e.g. this one'), 'Use e.g. this one');
  assert.equal(cleanupSpacing('Meet at 9 a.m. sharp'), 'Meet at 9 a.m. sharp');
});

test('still inserts a missing space after sentence punctuation', () => {
  assert.equal(cleanupSpacing('Ship it today.Review it tomorrow.'), 'Ship it today. Review it tomorrow.');
  assert.equal(cleanupSpacing('Hello,world'), 'Hello, world');
  assert.equal(cleanupSpacing('Really?Yes'), 'Really? Yes');
});

test('still removes a space before punctuation', () => {
  assert.equal(cleanupSpacing('Wait , then go .'), 'Wait, then go.');
});

test('collapses repeated spaces but preserves newlines', () => {
  assert.equal(cleanupSpacing('too    many     spaces'), 'too many spaces');
  assert.equal(cleanupSpacing('line one\n\nline two'), 'line one\n\nline two');
});

/* ── Paragraph preservation ───────────────────────────────────
   normalizeWhitespace flattens everything, which is why it must
   not be the first step of a rewrite. normalizeInlineWhitespace
   is the newline-safe variant.
   ───────────────────────────────────────────────────────────── */

test('normalizeWhitespace flattens newlines, as documented', () => {
  assert.equal(normalizeWhitespace('a\n\nb'), 'a b');
});

test('normalizeInlineWhitespace keeps newlines', () => {
  assert.equal(normalizeInlineWhitespace('a  b\n\nc  d'), 'a b\n\nc d');
});

/* ── Small helpers ───────────────────────────────────────────── */

test('ensureTrailingPunctuation adds only when missing', () => {
  assert.equal(ensureTrailingPunctuation('Done'), 'Done.');
  assert.equal(ensureTrailingPunctuation('Done.'), 'Done.');
  assert.equal(ensureTrailingPunctuation('Done!'), 'Done!');
  assert.equal(ensureTrailingPunctuation('Done?'), 'Done?');
  assert.equal(ensureTrailingPunctuation(''), '');
});

test('countWords handles contractions and blank input', () => {
  assert.equal(countWords("don't stop now"), 3);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('helpers never throw on null or undefined', () => {
  for (const fn of [cleanupSpacing, normalizeWhitespace, normalizeInlineWhitespace]) {
    assert.doesNotThrow(() => fn(null), `${fn.name} threw on null`);
    assert.doesNotThrow(() => fn(undefined), `${fn.name} threw on undefined`);
  }
});
