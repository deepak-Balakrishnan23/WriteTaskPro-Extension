/* =========================================================
   Tasve — Shared string helpers

   Pure functions only. No chrome.* access, so they can be
   imported by the service worker, the offscreen document, and
   the test runner alike.
   ========================================================= */

export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Collapses runs of spaces and tabs but leaves newlines alone. */
export function normalizeInlineWhitespace(text) {
  return String(text ?? '').replace(/[ \t]+/g, ' ').trim();
}

export function titleCase(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

export function escapeRegExp(str) {
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanupSpacing(text) {
  return String(text ?? '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])(?=[^\s])/g, (fullMatch, punctuation, offset, whole) => {
      const before = whole[offset - 1] ?? '';
      const after = whole[offset + 1] ?? '';

      // Inside a number: 4.2, 1,000, v1.2.3
      if (/\d/.test(before) && /\d/.test(after)) return punctuation;

      // Inside an acronym or abbreviation: U.S., e.g., a.m.
      // Recognised by a single letter sitting before the period.
      if (punctuation === '.' && /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) {
        const twoBefore = whole[offset - 2] ?? '';
        if (!/[A-Za-z]/.test(twoBefore)) return punctuation;
      }

      return `${punctuation} `;
    })
    .replace(/,\s*,+/g, ', ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sentenceCaseText(text) {
  return String(text ?? '')
    .replace(/(^|[.!?]\s+|\n+)([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/\bi\b/g, 'I');
}

export function ensureTrailingPunctuation(text) {
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function countWords(text) {
  return (String(text ?? '').trim().match(/\b[\w']+\b/g) || []).length;
}
