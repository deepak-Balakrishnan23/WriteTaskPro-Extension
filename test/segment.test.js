import test from 'node:test';
import assert from 'node:assert/strict';

import {
  segmentSentences,
  sentenceTexts,
  segmentBlocks,
  mapBlocks
} from '../lib/segment.js';

/* ── Regression cases from the audit ──────────────────────────
   Each of these produced wrong output under the old regex
   splitter, /[^.!?]+[.!?]?/g. The decimal case is the one that
   made summaries report the wrong figure.
   ───────────────────────────────────────────────────────────── */

test('does not split inside a decimal number', () => {
  const source = 'The company reported revenue of 4.2 billion dollars for the quarter.';
  assert.deepEqual(sentenceTexts(source), [source]);
});

test('the exact input that corrupted the summary stays intact', () => {
  // Old behaviour: ["Revenue hit $4.", "2B vs Dr.", "Lee's U.", "S.", ...]
  const source = "Revenue hit $4.2B vs Dr. Lee's U.S. forecast of 3.9B (e.g. v1.2.3).";
  assert.deepEqual(sentenceTexts(source), [source]);
});

test('does not split on initialisms', () => {
  assert.deepEqual(
    sentenceTexts('We filed with the U.S. office last week.'),
    ['We filed with the U.S. office last week.']
  );
});

test('does not split on a version string', () => {
  assert.deepEqual(
    sentenceTexts('Upgrade to v1.2.3 before Friday.'),
    ['Upgrade to v1.2.3 before Friday.']
  );
});

test('does not split after an honorific', () => {
  assert.deepEqual(
    sentenceTexts('Dr. Lee approved it.'),
    ['Dr. Lee approved it.']
  );
});

test('does not split between initials', () => {
  assert.deepEqual(
    sentenceTexts('J. R. R. Tolkien wrote it.'),
    ['J. R. R. Tolkien wrote it.']
  );
});

test('does not split on a trailing abbreviation mid-sentence', () => {
  assert.deepEqual(
    sentenceTexts('Send it to Acme Inc. before the deadline.'),
    ['Send it to Acme Inc. before the deadline.']
  );
});

/* ── It must still actually split ─────────────────────────────
   A segmenter that never splits would pass every test above.
   ───────────────────────────────────────────────────────────── */

test('splits real sentence boundaries', () => {
  assert.deepEqual(
    sentenceTexts('Ship it today. Review it tomorrow. Then rest.'),
    ['Ship it today.', 'Review it tomorrow.', 'Then rest.']
  );
});

test('splits on question and exclamation marks', () => {
  assert.deepEqual(
    sentenceTexts('Did it ship? It did! Good.'),
    ['Did it ship?', 'It did!', 'Good.']
  );
});

test('keeps a decimal intact while still splitting the following sentence', () => {
  assert.deepEqual(
    sentenceTexts('Revenue was 4.2 billion. Margins fell.'),
    ['Revenue was 4.2 billion.', 'Margins fell.']
  );
});

/* ── Offset contract ──────────────────────────────────────────
   Phase 1 hands these offsets to the grammar engine, so the
   slice invariant has to hold exactly.
   ───────────────────────────────────────────────────────────── */

test('offsets satisfy the slice invariant', () => {
  const source = 'Ship it today. Review it tomorrow. Then rest.';
  for (const sentence of segmentSentences(source)) {
    assert.equal(source.slice(sentence.start, sentence.end), sentence.text);
  }
});

test('offsets are UTF-16 code units, so emoji do not shift them', () => {
  const source = 'I love 🎉🎉 pizza. It is alot of fun.';
  const sentences = segmentSentences(source);
  for (const sentence of sentences) {
    assert.equal(source.slice(sentence.start, sentence.end), sentence.text);
  }
  assert.equal(sentences.length, 2);
});

test('returns nothing for blank input', () => {
  assert.deepEqual(segmentSentences(''), []);
  assert.deepEqual(segmentSentences('   \n  '), []);
  assert.deepEqual(segmentSentences(null), []);
  assert.deepEqual(segmentSentences(undefined), []);
});

/* ── Paragraph preservation ───────────────────────────────────
   The old pipeline ran normalizeWhitespace first, collapsing every
   newline, then reported a "Multiple spaces" issue on the text it
   had just flattened.
   ───────────────────────────────────────────────────────────── */

test('separates paragraphs on a blank line', () => {
  const source = 'First paragraph.\n\nSecond paragraph.';
  const blocks = segmentBlocks(source);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'First paragraph.');
  assert.equal(blocks[1].text, 'Second paragraph.');
});

test('a single newline is not a paragraph break', () => {
  const blocks = segmentBlocks('One line.\nStill same paragraph.');
  assert.equal(blocks.length, 1);
});

test('blocks reassemble into the exact original text', () => {
  const sources = [
    'First.\n\nSecond.',
    'First.\n\n\n\nSecond.',
    '\n\nLeading break.\n\nMiddle.\n\n',
    'No breaks at all.',
    'Trailing spaces before break.   \n\n   Indented next.',
    ''
  ];
  for (const source of sources) {
    const rebuilt = segmentBlocks(source)
      .map((block) => block.text + block.separator)
      .join('');
    assert.equal(rebuilt, source, `lossless round-trip failed for ${JSON.stringify(source)}`);
  }
});

test('mapBlocks preserves paragraph structure through a transform', () => {
  const source = 'the reports were completed.\n\nthe second paragraph should survive.';
  const result = mapBlocks(source, (block) => block.toUpperCase());
  assert.equal(
    result,
    'THE REPORTS WERE COMPLETED.\n\nTHE SECOND PARAGRAPH SHOULD SURVIVE.'
  );
});

test('mapBlocks leaves whitespace-only blocks untouched', () => {
  const source = 'Real text.\n\n   \n\nMore text.';
  const result = mapBlocks(source, () => 'REPLACED');
  assert.equal(result, 'REPLACED\n\n   \n\nREPLACED');
});

test('mapBlocks with an identity transform is lossless', () => {
  const source = 'A.\n\nB.\n\n\nC.\n';
  assert.equal(mapBlocks(source, (block) => block), source);
});
