/* =========================================================
   WriteTask Pro — Text segmentation

   Replaces the regex sentence splitter that shattered on every
   period. That splitter turned "revenue of 4.2 billion" into the
   fragments "revenue of 4." and "2 billion", and a downstream
   word-count filter dropped the first one — so summaries reported
   the wrong figure.

   Every function here reports UTF-16 offsets, matching the offset
   convention the grammar engine uses, so positions can be handed
   straight to String.slice().
   ========================================================= */

const SENTENCE_SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' });

/* ICU splits after any period followed by a capital, so honorifics and
   short abbreviations still need guarding. Decimals, initialisms like
   U.S., "e.g." and version strings are already handled correctly. */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'rev', 'hon', 'sr', 'jr',
  'gen', 'col', 'sgt', 'capt', 'lt', 'st', 'mt',
  'inc', 'ltd', 'co', 'corp', 'dept', 'div', 'est',
  'fig', 'vol', 'ed', 'eds', 'al', 'etc', 'vs', 'approx', 'apt', 'no'
]);

function endsWithAbbreviation(text) {
  const match = text.match(/(?:^|[\s(["'])([A-Za-z]{1,6})\.[\s)"']*$/);
  if (!match) return false;
  const word = match[1];
  // A lone capital before a period is an initial: "J. R. R. Tolkien".
  if (word.length === 1) return word === word.toUpperCase();
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split text into sentences.
 * Returns [{ text, start, end }] with raw slices — text includes any
 * trailing whitespace so that start/end always satisfy
 * source.slice(start, end) === text. Callers that want a bare sentence
 * should trim it themselves.
 */
export function segmentSentences(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  const merged = [];
  for (const segment of SENTENCE_SEGMENTER.segment(source)) {
    const previous = merged[merged.length - 1];
    if (previous && endsWithAbbreviation(previous.text)) {
      previous.text += segment.segment;
      previous.end = segment.index + segment.segment.length;
      continue;
    }
    merged.push({
      text: segment.segment,
      start: segment.index,
      end: segment.index + segment.segment.length
    });
  }

  return merged.filter((sentence) => sentence.text.trim().length > 0);
}

/** Sentence text only, trimmed. For callers that do not need positions. */
export function sentenceTexts(text) {
  return segmentSentences(text).map((sentence) => sentence.text.trim());
}

/**
 * Split text into paragraph blocks.
 * Each block carries the separator that followed it, so
 * blocks.map(b => b.text + b.separator).join('') reproduces the input
 * exactly. This is what keeps rewrites from flattening documents.
 */
export function segmentBlocks(text) {
  const source = String(text ?? '');
  if (!source) return [];

  const separatorPattern = /(?:[ \t\r]*\n){2,}[ \t\r]*/g;
  const blocks = [];
  let cursor = 0;
  let match;

  while ((match = separatorPattern.exec(source)) !== null) {
    blocks.push({
      text: source.slice(cursor, match.index),
      start: cursor,
      end: match.index,
      separator: match[0]
    });
    cursor = match.index + match[0].length;
  }

  blocks.push({
    text: source.slice(cursor),
    start: cursor,
    end: source.length,
    separator: ''
  });

  return blocks;
}

/**
 * Apply a transform to each paragraph and rejoin with the original
 * separators intact. Empty blocks pass through untouched.
 */
export function mapBlocks(text, transform) {
  return segmentBlocks(text)
    .map((block) => (block.text.trim() ? transform(block.text) : block.text) + block.separator)
    .join('');
}
