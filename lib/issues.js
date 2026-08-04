/* =========================================================
   Tasve — The issue contract

   Every grammar or spelling problem crosses process boundaries as
   a plain, structured-cloneable object:

     {
       offset,        // UTF-16 code units into the source text
       length,        // span length in the same units
       ruleId,        // engine rule identifier, e.g. "Spelling"
       severity,      // 'spelling' | 'grammar' | 'style'
       message,       // human-readable explanation
       problemText,   // the exact flagged text, used to detect staleness
       replacements   // [{ text, kind }] — never applied automatically
     }

   The old contract was {original, suggestion, rule, explanation} —
   strings with no position. That is why the product could only ever
   offer one whole-sentence swap: without offsets you cannot draw a
   mark under a span, and you cannot replace one without rewriting
   the entire field.

   Offsets are UTF-16 code units, matching both String.prototype.slice
   and Harper's own spans, so no index conversion is needed. Harper's
   docs call them "character indices", which would imply codepoints —
   they are not, and treating them as codepoints corrupts any text
   containing emoji.
   ========================================================= */

export const SEVERITY = {
  SPELLING: 'spelling',
  GRAMMAR: 'grammar',
  STYLE: 'style'
};

export const REPLACEMENT_KIND = {
  REPLACE: 'replace',
  REMOVE: 'remove',
  INSERT_AFTER: 'insertAfter'
};

/* Harper's SuggestionKind is a numeric enum: 0 Replace, 1 Remove, 2 InsertAfter. */
const SUGGESTION_KINDS = [
  REPLACEMENT_KIND.REPLACE,
  REPLACEMENT_KIND.REMOVE,
  REPLACEMENT_KIND.INSERT_AFTER
];

export function replacementKindName(kind) {
  return SUGGESTION_KINDS[kind] || REPLACEMENT_KIND.REPLACE;
}

/* Harper reports many rule kinds. Only the split into spelling, grammar
   and style matters to the UI, which colours marks by severity. Anything
   unrecognised is treated as style, the least assertive option. */
const SPELLING_KINDS = new Set(['Spelling', 'Capitalization', 'BoundaryError', 'Repetition']);
const GRAMMAR_KINDS = new Set(['Grammar', 'Agreement', 'Punctuation', 'Regionalism', 'Malapropism', 'Typo']);

export function severityForKind(kind) {
  if (SPELLING_KINDS.has(kind)) return SEVERITY.SPELLING;
  if (GRAMMAR_KINDS.has(kind)) return SEVERITY.GRAMMAR;
  return SEVERITY.STYLE;
}

/**
 * Build a contract issue from raw engine output.
 * Returns null when the span is unusable, so a single malformed lint
 * cannot take down a whole check.
 */
export function makeIssue({ start, end, kind, message, suggestions = [] }, sourceText = '') {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;
  if (sourceText && end > sourceText.length) return null;

  return {
    offset: start,
    length: end - start,
    ruleId: String(kind || 'Unknown'),
    severity: severityForKind(kind),
    message: String(message || ''),
    problemText: sourceText ? sourceText.slice(start, end) : '',
    replacements: suggestions
      .map((suggestion) => ({
        text: String(suggestion?.text ?? ''),
        kind: replacementKindName(suggestion?.kind)
      }))
      /* Harper sometimes emits a replacement identical to the flagged text
         plus a trailing space; those are not useful choices for a user. */
      .filter((replacement, index, all) =>
        all.findIndex((other) => other.text.trim() === replacement.text.trim()) === index)
  };
}

/**
 * True when the text has changed underneath an issue, so its offsets no
 * longer point at what was flagged. Applying a stale issue would corrupt
 * unrelated text, which is the failure mode worth guarding hardest.
 */
export function isIssueStale(text, issue) {
  if (!issue || typeof text !== 'string') return true;
  const { offset, length, problemText } = issue;
  if (offset < 0 || offset + length > text.length) return true;
  /* An issue with no recorded problemText cannot be verified, so it counts
     as stale. Refusing an unverifiable edit is always cheaper than applying
     one to the wrong span. content.js carries an identical copy of this
     check — test/content.security.test.js asserts the two agree. */
  return text.slice(offset, offset + length) !== problemText;
}

/**
 * Apply one replacement to the text, touching only the issue's span.
 * Returns the new string, or null when the issue is stale.
 *
 * This is what makes it possible to accept a suggestion without
 * rewriting the whole field — the behaviour that used to discard every
 * link, list and bold run in a rich editor.
 */
export function applyIssue(text, issue, replacementIndex = 0) {
  if (isIssueStale(text, issue)) return null;

  const replacement = issue.replacements?.[replacementIndex];
  if (!replacement) return null;

  const before = text.slice(0, issue.offset);
  const after = text.slice(issue.offset + issue.length);

  if (replacement.kind === REPLACEMENT_KIND.REMOVE) {
    // Removing a word leaves two spaces behind; close the gap.
    if (/\s$/.test(before) && /^\s/.test(after)) return before + after.replace(/^\s+/, '');
    return before + after;
  }

  if (replacement.kind === REPLACEMENT_KIND.INSERT_AFTER) {
    return before + issue.problemText + replacement.text + after;
  }

  return before + replacement.text + after;
}

/** Reading order: by position, then longer spans first for stable nesting. */
export function sortIssues(issues) {
  return [...issues].sort((a, b) => a.offset - b.offset || b.length - a.length);
}

/**
 * Drop issues whose spans overlap an earlier one. Two marks over the same
 * characters cannot both be applied, and rendering both reads as a bug.
 */
export function dropOverlapping(issues) {
  const kept = [];
  let boundary = -1;
  for (const issue of sortIssues(issues)) {
    if (issue.offset < boundary) continue;
    kept.push(issue);
    boundary = issue.offset + issue.length;
  }
  return kept;
}
