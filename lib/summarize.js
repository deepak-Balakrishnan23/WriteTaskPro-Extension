/* =========================================================
   WriteTask Pro — Extractive summarizer

   This picks existing sentences. It does not paraphrase, and it
   does not generate. Two rules follow from that:

   1. Never truncate a sentence mid-way. A clipped sentence can
      invert its own meaning ("Revenue grew 40% but margins
      collapsed" → "Revenue grew 40%..."), so a sentence is either
      included whole or dropped.
   2. Never bias toward a topic. The previous scorer awarded bonus
      points for sports vocabulary, which silently down-ranked
      every other subject.
   ========================================================= */

import { segmentSentences } from './segment.js';
import {
  normalizeWhitespace,
  cleanupSpacing,
  sentenceCaseText,
  ensureTrailingPunctuation
} from './text.js';

const BOILERPLATE = /^(advertisement|sponsored|share|copy link|sign in|log in|subscribe|follow us)$/i;

const MIN_LINE_LENGTH = 25;
const MIN_SENTENCE_WORDS = 7;
const MAX_SENTENCE_LENGTH = 220;
const MAX_TITLE_LENGTH = 80;

function normalizeSummaryLines(content) {
  const seen = new Set();
  return String(content ?? '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .filter((line) => line.length >= MIN_LINE_LENGTH || isLikelyHeading(line))
    .filter((line) => !BOILERPLATE.test(line))
    .filter((line) => {
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function isLikelyHeading(line) {
  if (!line) return false;
  if (line.length > MAX_TITLE_LENGTH) return false;
  if (/[.!?]$/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 12) return false;
  return /^(?:[A-Z][\w&/-]*\s*)+$/.test(line) || /^[A-Z][A-Za-z\s&/-]+$/.test(line);
}

/* Strips attribution scaffolding that carries no information in a summary.
   Only removes framing clauses — never facts, figures, or qualifiers. */
function compressSummarySentence(sentence) {
  let result = cleanupSpacing(sentence ?? '');
  if (!result) return '';

  result = result
    .replace(/^\s*(per|according to)\s+[^,]+,\s*/i, '')
    .replace(/^\s*sources?\s+(said|added|claimed|reported)\s+that\s*/i, '')
    .replace(/\b(a report|reports?)\s+(has\s+)?(claimed|said|reported)\s+that\s*/i, '')
    .replace(/\bsource(s)?\s+(said|added)\s+that\s*/gi, '')
    .replace(/\bhas (claimed|said) that\b/gi, '');

  return ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(result)));
}

function scoreSummarySentence(sentence, index, titleWords) {
  const words = sentence.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const uniqueWords = new Set(words);
  let score = uniqueWords.size;

  // News and reports front-load the important material.
  if (index < 3) score += 4;

  // Mid-length sentences carry a claim without rambling.
  if (sentence.length >= 55 && sentence.length <= 180) score += 3;

  // Overlap with the heading signals topicality.
  if (titleWords?.size) {
    score += [...uniqueWords].filter((word) => titleWords.has(word)).length * 2;
  }

  if (/[:|]/.test(sentence)) score += 2;
  return score;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from']);

function getTitleWords(title) {
  return new Set(
    (title.toLowerCase().match(/\b[a-z]{3,}\b/g) || []).filter((word) => !STOP_WORDS.has(word))
  );
}

export function buildBriefSummary(content) {
  const lines = normalizeSummaryLines(content);
  if (!lines.length) return 'No readable content found.';

  const title = lines.find(isLikelyHeading) || '';
  const bodyLines = title ? lines.filter((line) => line !== title) : lines;

  const candidates = segmentSentences(bodyLines.join(' '))
    .map((sentence, index) => ({ text: cleanupSpacing(sentence.text), index }))
    .filter((sentence) => (sentence.text.match(/\b[\w']+\b/g) || []).length >= MIN_SENTENCE_WORDS)
    .filter((sentence) => sentence.text.length <= MAX_SENTENCE_LENGTH);

  if (!candidates.length) {
    return title ? `${title}: no summarizable sentences found.` : 'No summarizable sentences found.';
  }

  const titleWords = getTitleWords(title);
  const ranked = candidates
    .map((sentence) => ({
      ...sentence,
      score: scoreSummarySentence(sentence.text, sentence.index, titleWords)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);

  const parts = ranked.map((item) => compressSummarySentence(item.text)).filter(Boolean);
  if (!parts.length) return 'No summarizable sentences found.';

  const lead = parts[0].replace(/[.!?]+$/, '');
  const intro = title ? `${title}: ${lead}.` : `In short: ${lead}.`;
  const bullets = parts.slice(1, 3).map((part) => `• ${part.replace(/^[•\-\s]+/, '')}`);

  return [intro, ...bullets].join('\n');
}
