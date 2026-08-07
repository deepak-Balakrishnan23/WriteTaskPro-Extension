/* =========================================================
   WriteTask Pro — Background Service Worker

   Local-first rewrite:
   - No API calls
   - No API keys
   - All writing/task logic runs in-browser
   ========================================================= */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'writetask-paraphrase', title: 'WriteTask Pro: Paraphrase Selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-grammar', title: 'WriteTask Pro: Check Grammar', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-add-task', title: 'WriteTask Pro: Add as Task', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-extract-tasks', title: 'WriteTask Pro: Extract Tasks from Selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-summarize', title: 'WriteTask Pro: Summarize Page', contexts: ['page'] });
  });

  chrome.storage.local.get(['wtp_settings'], (result) => {
    if (!result.wtp_settings) {
      chrome.storage.local.set({
        wtp_settings: {
          theme: 'system',
          aiEngine: 'auto'
        }
      });
    }
  });

});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg).catch(() => {});

  if (info.menuItemId === 'writetask-paraphrase') send({ action: 'contextMenuParaphrase', text: info.selectionText });
  else if (info.menuItemId === 'writetask-grammar') send({ action: 'contextMenuGrammar', text: info.selectionText });
  else if (info.menuItemId === 'writetask-add-task') send({ action: 'contextMenuAddTask', text: info.selectionText, url: info.pageUrl });
  else if (info.menuItemId === 'writetask-extract-tasks') send({ action: 'contextMenuExtractTasks', text: info.selectionText });
  else if (info.menuItemId === 'writetask-summarize') send({ action: 'contextMenuSummarize' });
});

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function titleCase(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceWholeWord(text, original, suggestion) {
  const regex = new RegExp(`\\b${escapeRegExp(original)}\\b`, 'gi');
  return text.replace(regex, (match) => {
    if (match.toUpperCase() === match) return suggestion.toUpperCase();
    if (match[0] === match[0].toUpperCase()) return titleCase(suggestion);
    return suggestion;
  });
}

function cleanupSpacing(text) {
  return text
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])(?=[^\s])/g, '$1 ')
    .replace(/,\s*,+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sentenceCaseText(text) {
  return (text || '')
    .replace(/(^|[.!?]\s+|\n+)([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/\bi\b/g, 'I');
}

function ensureTrailingPunctuation(text) {
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function applyPhraseReplacements(text, replacements) {
  let result = text;
  replacements.forEach(([pattern, replacement]) => {
    result = result.replace(pattern, replacement);
  });
  return result;
}

/* =========================================================
   AI Provider — Chrome Built-in AI (Gemini Nano / Prompt API)
   with a graceful fallback to the local rules engine.

   Everything is funnelled through aiProvider.run(task, text) so
   the rest of the code never touches a vendor API directly. If the
   on-device model is unavailable (unsupported browser, hardware not
   ready, model still downloading, or user turned it off), run()
   returns null and the caller uses the deterministic rules engine.
   ========================================================= */

const AI_SYSTEM_PROMPT =
  'You are a precise writing assistant. You improve text while preserving its ' +
  'original meaning, intent, and language. Output only the requested result — ' +
  'no explanations, no preamble, no surrounding quotation marks or code fences.';

const AI_TASK_PROMPTS = {
  grammar: (text) =>
    'Correct all spelling, grammar, and punctuation mistakes in the text below. ' +
    'Keep the same meaning, tone, and language. Do not rephrase beyond what is ' +
    `needed to fix errors. Return only the corrected text.\n\nText:\n${text}`,
  paraphrase: (text, opts) => {
    const instructions = {
      standard: 'Rewrite the text below to be clearer and more natural.',
      formal: 'Rewrite the text below in a formal, professional tone.',
      casual: 'Rewrite the text below in a casual, friendly tone.',
      shorten: 'Rewrite the text below to be more concise while keeping the key information.',
      expand: 'Rewrite the text below with more detail, explanation, and context.',
      creative: 'Rewrite the text below in a more vivid, engaging, and creative way.'
    };
    const mode = (opts && opts.mode) || 'standard';
    return `${instructions[mode] || instructions.standard} Return only the rewritten text.\n\nText:\n${text}`;
  },
  summarize: (text) =>
    'Summarize the text below. Start with a one-sentence overview, then add 2-3 ' +
    'concise bullet points each starting with "• ". Return only the summary.\n\n' +
    `Text:\n${text}`,
  extractTasks: (text) =>
    'Extract the action items / to-do tasks from the text below. Output one task ' +
    'per line in short imperative form (e.g. "Email Sarah the report"). Keep any ' +
    'due date or time that is mentioned. Do not number the lines, do not add any ' +
    'commentary. If there are no clear tasks, output nothing.\n\n' +
    `Text:\n${text}`,
  tone: (text) =>
    'Analyze the tone of the text below. On the first line, list the 1-3 dominant ' +
    'tones as a comma-separated list (e.g. "Confident, Friendly"). On the second ' +
    'line, write one short sentence of feedback on how it may read to the reader. ' +
    'Return nothing else.\n\n' +
    `Text:\n${text}`,
  translate: (text, opts) =>
    `Translate the text below into ${(opts && opts.lang) || 'English'}. Preserve the ` +
    'meaning and tone. Return only the translation, with no notes or quotation marks.\n\n' +
    `Text:\n${text}`,
  synonyms: (text) =>
    `List up to 6 common synonyms for the word "${text}". Return only a ` +
    'comma-separated list of single words, no numbering and no extra commentary.',
  complete: (text) =>
    'Continue the text below naturally with a short completion of at most 12 words. ' +
    'Return ONLY the continuation that should follow — do not repeat the given text, ' +
    'do not add quotation marks.\n\n' +
    `Text:\n${text}`
};

function cleanModelOutput(raw) {
  let out = String(raw || '').trim();
  if (!out) return '';
  // Strip code fences the model may wrap around output.
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  // Strip a single pair of wrapping quotes.
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  // Drop a leading conversational preamble like "Sure, here is..." if present.
  out = out.replace(/^(sure|certainly|here(?:'s| is)|okay|of course)[^\n:]*:\s*/i, '').trim();
  return out;
}

function withTimeout(promise, ms, label = 'AI request') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
  ]);
}

const aiProvider = {
  get supported() {
    return typeof LanguageModel !== 'undefined';
  },
  _enabled: true,          // mirrors the user's "writing engine" setting
  _unavailable: false,     // model reported unavailable on this device
  _baseSession: null,
  _downloading: false,

  setEnabled(enabled) {
    this._enabled = enabled !== false;
  },

  async _availability() {
    try {
      return await LanguageModel.availability();
    } catch {
      return 'unavailable';
    }
  },

  _startBackgroundDownload() {
    if (this._downloading || this._baseSession) return;
    this._downloading = true;
    LanguageModel.create({
      initialPrompts: [{ role: 'system', content: AI_SYSTEM_PROMPT }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          console.log(`WriteTask Pro: on-device model downloading ${Math.round((e.loaded || 0) * 100)}%`);
        });
      }
    })
      .then((session) => { this._baseSession = session; })
      .catch(() => { this._unavailable = true; })
      .finally(() => { this._downloading = false; });
  },

  async _getSession() {
    if (!this.supported || !this._enabled || this._unavailable) return null;
    if (this._baseSession) return this._baseSession;

    const status = await this._availability();
    if (status === 'unavailable') {
      this._unavailable = true;
      return null;
    }
    if (status === 'available') {
      try {
        this._baseSession = await LanguageModel.create({
          initialPrompts: [{ role: 'system', content: AI_SYSTEM_PROMPT }]
        });
        return this._baseSession;
      } catch {
        this._unavailable = true;
        return null;
      }
    }
    // 'downloadable' / 'downloading' — fetch in the background and use the
    // rules engine for now; the model auto-upgrades on a later request.
    this._startBackgroundDownload();
    return null;
  },

  async status() {
    if (!this.supported) return { supported: false, state: 'unsupported' };
    if (!this._enabled) return { supported: true, state: 'off' };
    if (this._baseSession) return { supported: true, state: 'ready' };
    if (this._downloading) return { supported: true, state: 'downloading' };
    const availability = await this._availability();
    return { supported: true, state: availability };
  },

  async run(task, text, opts) {
    const source = String(text || '').trim();
    if (!source) return null;

    const buildPrompt = AI_TASK_PROMPTS[task];
    if (!buildPrompt) return null;

    const base = await this._getSession();
    if (!base) return null;

    let session = null;
    try {
      // Clone so each request is stateless (no accumulated context).
      session = typeof base.clone === 'function' ? await base.clone() : base;
      const result = await withTimeout(session.prompt(buildPrompt(source, opts)), 20000, 'On-device AI');
      const cleaned = cleanModelOutput(result);
      return cleaned || null;
    } catch (err) {
      console.warn('WriteTask Pro: AI run failed, using rules fallback —', err.message);
      return null;
    } finally {
      if (session && session !== base && typeof session.destroy === 'function') {
        try { session.destroy(); } catch { /* noop */ }
      }
    }
  }
};

/* ── Word-level diff → inline suggestion spans ──
   The AI (or the rules engine) returns a corrected full string. We diff it
   against the original so we can surface precise character offsets for the
   inline underlines, regardless of which engine produced the correction. */

function tokenizeWithOffsets(text) {
  const tokens = [];
  const re = /\S+|\s+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      ws: /^\s+$/.test(match[0])
    });
  }
  return tokens;
}

function lcsOps(a, b) {
  // a, b are arrays of token value strings. Returns a list of ops:
  // { type: 'equal'|'delete'|'insert', ai, bi }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', ai: i, bi: j });
      i += 1; j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', ai: i });
      i += 1;
    } else {
      ops.push({ type: 'insert', bi: j });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: 'delete', ai: i }); i += 1; }
  while (j < m) { ops.push({ type: 'insert', bi: j }); j += 1; }
  return ops;
}

function diffToIssues(original, corrected) {
  const origTokens = tokenizeWithOffsets(original);
  const corrTokens = tokenizeWithOffsets(corrected);
  const ops = lcsOps(origTokens.map((t) => t.value), corrTokens.map((t) => t.value));

  const issues = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') { k += 1; continue; }

    // Gather a contiguous run of non-equal ops into a single change region.
    const deleted = [];
    const inserted = [];
    while (k < ops.length && ops[k].type !== 'equal') {
      if (ops[k].type === 'delete') deleted.push(origTokens[ops[k].ai]);
      else inserted.push(corrTokens[ops[k].bi]);
      k += 1;
    }

    const originalText = deleted.map((t) => t.value).join('');
    const suggestionText = inserted.map((t) => t.value).join('');

    // Ignore pure-whitespace churn (e.g. collapsing double spaces handled elsewhere).
    if (originalText.trim() === suggestionText.trim()) continue;

    // We need an anchorable range in the ORIGINAL text for the underline.
    let start;
    let end;
    if (deleted.length) {
      start = deleted[0].start;
      end = deleted[deleted.length - 1].end;
    } else {
      // Pure insertion: anchor onto the character before the insertion point.
      const anchor = issues.length ? null : null;
      // Find the original offset just after the previous equal token.
      const prevOp = ops[k - inserted.length - 1];
      start = prevOp && prevOp.ai != null ? origTokens[prevOp.ai].end : 0;
      end = Math.min(original.length, start + 1);
      void anchor;
    }

    issues.push({
      start,
      end,
      original: originalText || original.slice(start, end),
      suggestion: suggestionText,
      rule: classifyEdit(originalText, suggestionText),
      explanation: 'Suggested improvement for clarity and correctness.'
    });
  }

  return issues;
}

function classifyEdit(original, suggestion) {
  const o = original.trim();
  const s = suggestion.trim();
  if (!s) return 'Wordiness';
  if (!o) return 'Missing word';
  if (o.toLowerCase() === s.toLowerCase()) return 'Capitalization';
  if (o.replace(/[.,!?;:'"]/g, '') === s.replace(/[.,!?;:'"]/g, '')) return 'Punctuation';
  if (o.split(/\s+/).length === 1 && s.split(/\s+/).length === 1) return 'Spelling';
  return 'Grammar';
}

// Small, generic informal-to-standard token fixes (rules-engine fallback only).
const TOKEN_CORRECTIONS = {
  ur: 'your',
  pls: 'please',
  plz: 'please',
  thx: 'thanks'
};

function normalizeTokens(text) {
  return String(text || '').replace(/\b[a-zA-Z]{2,}\b/g, (token) => {
    const corrected = TOKEN_CORRECTIONS[token.toLowerCase()];
    if (corrected) {
      if (token[0] === token[0].toUpperCase()) {
        return corrected.replace(/\b([a-z])/g, (match, letter, offset) => offset === 0 ? letter.toUpperCase() : letter);
      }
      return corrected;
    }
    return token;
  });
}

function applyCoreCorrections(text) {
  let result = normalizeTokens(normalizeWhitespace(text))
    .replace(/\bi am\b/gi, 'I am')
    .replace(/\bim\b/gi, "I'm")
    .replace(/\bi\b/g, 'I');

  COMMON_REPLACEMENTS.forEach(([original, suggestion]) => {
    result = replaceWholeWord(result, original, suggestion);
  });

  result = cleanupSpacing(sentenceCaseText(result));
  return ensureTrailingPunctuation(result);
}

const COMMON_REPLACEMENTS = [
  ['teh', 'the', 'Spelling', 'A common typo.'],
  ['recieve', 'receive', 'Spelling', '“Receive” follows the “i before e except after c” pattern.'],
  ['seperate', 'separate', 'Spelling', 'The correct spelling is “separate.”'],
  ['definately', 'definitely', 'Spelling', 'The correct spelling is “definitely.”'],
  ['occured', 'occurred', 'Spelling', '“Occurred” uses a double “r.”'],
  ['alot', 'a lot', 'Word choice', 'Use “a lot” as two words.'],
  ['wich', 'which', 'Spelling', 'The standard form is “which.”'],
  ['becuase', 'because', 'Spelling', 'The correct spelling is “because.”'],
  ['dont', "don't", 'Punctuation', 'Add the apostrophe in the contraction.'],
  ['cant', "can't", 'Punctuation', 'Add the apostrophe in the contraction.'],
  ['wont', "won't", 'Punctuation', 'Add the apostrophe in the contraction.'],
  ['doesnt', "doesn't", 'Punctuation', 'Add the apostrophe in the contraction.'],
  ['im', "I'm", 'Capitalization', 'Capitalize the pronoun and add the apostrophe.']
];

// ── Custom dictionary (words the user marked as correct) ──
let dictionaryCache = null;

async function getDictionary() {
  if (dictionaryCache) return dictionaryCache;
  const res = await chrome.storage.local.get(['wtp_dictionary']);
  dictionaryCache = new Set((res.wtp_dictionary || []).map((w) => String(w).toLowerCase()));
  return dictionaryCache;
}

async function addDictionaryWord(word) {
  const w = String(word || '').trim().toLowerCase();
  const res = await chrome.storage.local.get(['wtp_dictionary']);
  const list = res.wtp_dictionary || [];
  if (w && !list.some((x) => String(x).toLowerCase() === w)) list.push(w);
  await chrome.storage.local.set({ wtp_dictionary: list });
  dictionaryCache = new Set(list.map((x) => String(x).toLowerCase()));
  return list;
}

async function removeDictionaryWord(word) {
  const w = String(word || '').trim().toLowerCase();
  const res = await chrome.storage.local.get(['wtp_dictionary']);
  const list = (res.wtp_dictionary || []).filter((x) => String(x).toLowerCase() !== w);
  await chrome.storage.local.set({ wtp_dictionary: list });
  dictionaryCache = new Set(list.map((x) => String(x).toLowerCase()));
  return list;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.wtp_dictionary) {
    dictionaryCache = new Set((changes.wtp_dictionary.newValue || []).map((w) => String(w).toLowerCase()));
  }
});

// Full-text correction: on-device AI when available, rules engine otherwise.
async function correctText(text) {
  const ai = await aiProvider.run('grammar', text);
  if (ai != null) return ai;
  return applyStandardRewrite(text);
}

// Returns inline suggestion spans (with character offsets) for the given text.
async function checkGrammar(text) {
  const rawText = text || '';
  if (!rawText.trim()) return [];

  const corrected = await correctText(rawText);
  if (!corrected || cleanupSpacing(corrected) === cleanupSpacing(rawText)) return [];

  let issues = diffToIssues(rawText, corrected);

  // Skip single words the user added to their personal dictionary.
  const dict = await getDictionary();
  if (dict.size) {
    issues = issues.filter((i) => {
      const o = (i.original || '').trim().toLowerCase();
      return !(o && !/\s/.test(o) && dict.has(o));
    });
  }
  if (!issues.length) return [];

  // Attach the full corrected text so callers can offer a one-click "fix all".
  return issues.slice(0, 25).map((issue) => ({ ...issue, fullCorrection: corrected }));
}

function applyStandardRewrite(text) {
  let result = applyCoreCorrections(text);

  [
    ['utilize', 'use'],
    ['in order to', 'to'],
    ['at this point in time', 'now'],
    ['due to the fact that', 'because'],
    ['a number of', 'several'],
    ['kind of', 'somewhat'],
    ['sort of', 'somewhat']
  ].forEach(([from, to]) => {
    result = replaceWholeWord(result, from, to);
  });

  const sentences = splitSentences(result).map((sentence) => {
    const clean = cleanupSpacing(sentence);
    return clean ? titleCase(clean) : clean;
  });

  result = cleanupSpacing(sentences.join(' '));
  result = applyPhraseReplacements(result, [
    [/\bI want leave\b/gi, 'I want to leave'],
    [/\bI need leave\b/gi, 'I need to leave'],
    [/\bI want go\b/gi, 'I want to go'],
    [/\bI need go\b/gi, 'I need to go'],
    [/\bI want take leave\b/gi, 'I want to take leave'],
    [/\bI need take leave\b/gi, 'I need to take leave']
  ]);
  return ensureTrailingPunctuation(result);
}

function applyFormalRewrite(text) {
  let result = applyStandardRewrite(text);
  [
    ["can't", 'cannot'],
    ["won't", 'will not'],
    ["don't", 'do not'],
    ["doesn't", 'does not'],
    ["isn't", 'is not'],
    ["it's", 'it is'],
    ["we're", 'we are'],
    ["I'm", 'I am'],
    ['kids', 'children'],
    ['buy', 'purchase'],
    ['get', 'obtain'],
    ['help', 'assist']
  ].forEach(([from, to]) => {
    result = replaceWholeWord(result, from, to);
  });

  return ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(result)));
}

function applyCasualRewrite(text) {
  let result = applyStandardRewrite(text);
  [
    ['cannot', "can't"],
    ['do not', "don't"],
    ['will not', "won't"],
    ['I am', "I'm"],
    ['we are', "we're"],
    ['it is', "it's"],
    ['you are', "you're"]
  ].forEach(([from, to]) => {
    result = replaceWholeWord(result, from, to);
  });

  return ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(result)));
}

function applyShortenRewrite(text) {
  const fillers = /\b(really|very|actually|basically|just|perhaps|quite|somewhat|that)\b/gi;
  return cleanupSpacing(
    applyStandardRewrite(text)
      .replace(fillers, '')
      .replace(/\s{2,}/g, ' ')
  );
}

function applyExpandRewrite(text) {
  const sentences = splitSentences(applyStandardRewrite(text));
  return sentences
    .map((sentence, index) => {
      if (sentence.split(' ').length < 7) {
        const prefix = index === 0 ? 'To add a bit more context, ' : 'In practical terms, ';
        return `${prefix}${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
      }
      return `${sentence} This adds a bit more clarity and context.`;
    })
    .join(' ');
}

function applyCreativeRewrite(text) {
  const sentences = splitSentences(applyStandardRewrite(text));
  return sentences
    .map((sentence, index) => {
      const prefix = index === 0 ? 'Think of it this way: ' : 'Another way to frame it: ';
      return `${prefix}${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
    })
    .join(' ');
}

async function paraphraseText(text, mode = 'standard') {
  const source = text || '';
  if (!source.trim()) return '';

  const ai = await aiProvider.run('paraphrase', source, { mode });
  if (ai != null) return ai;

  switch (mode) {
    case 'formal':
      return applyFormalRewrite(source);
    case 'casual':
      return applyCasualRewrite(source);
    case 'shorten':
      return applyShortenRewrite(source);
    case 'expand':
      return applyExpandRewrite(source);
    case 'creative':
      return applyCreativeRewrite(source);
    case 'standard':
    default:
      return applyStandardRewrite(source);
  }
}

const SIMPLE_WORD_MAP = {
  utilize: 'use',
  commence: 'start',
  terminate: 'end',
  assistance: 'help',
  approximately: 'about',
  demonstrate: 'show',
  facilitate: 'help',
  purchase: 'buy',
  obtain: 'get',
  numerous: 'many',
  regarding: 'about',
  sufficient: 'enough',
  additional: 'more',
  therefore: 'so',
  however: 'but',
  moreover: 'and',
  inquire: 'ask',
  reside: 'live',
  modification: 'change',
  objective: 'goal',
  requirement: 'need',
  verify: 'check',
  initiate: 'start',
  prior: 'before',
  subsequent: 'later',
  indicate: 'show'
};

function normalizeForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getWords(text) {
  return normalizeWhitespace(text)
    .match(/\b[\w']+\b/g) || [];
}

function getBigrams(text) {
  const words = getWords(normalizeForComparison(text));
  if (words.length < 2) return new Set(words);

  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i += 1) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  const intersection = [...setA].filter((item) => setB.has(item)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function replaceSimpleWords(text) {
  let result = text;
  Object.entries(SIMPLE_WORD_MAP).forEach(([complex, simple]) => {
    result = replaceWholeWord(result, complex, simple);
  });
  return result;
}

function humanizeConnectors(text) {
  return applyPhraseReplacements(text, [
    [/\bit is important to note that\b/gi, ''],
    [/\bit should be noted that\b/gi, ''],
    [/\bin order to\b/gi, 'to'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bat this point in time\b/gi, 'now'],
    [/\bas a result\b/gi, 'so'],
    [/\bin addition\b/gi, 'and'],
    [/\bfor the purpose of\b/gi, 'for'],
    [/\bwith regard to\b/gi, 'about']
  ]);
}

function depassivizeSentence(text) {
  let result = text;
  result = result.replace(
    /\b(.+?)\s+was\s+([a-z]+ed)\s+by\s+(.+?)\b/i,
    (match, subject, verb, actor) => `${titleCase(cleanupSpacing(actor))} ${verb} ${cleanupSpacing(subject).toLowerCase()}`
  );
  result = result.replace(
    /\b(.+?)\s+were\s+([a-z]+ed)\s+by\s+(.+?)\b/i,
    (match, subject, verb, actor) => `${titleCase(cleanupSpacing(actor))} ${verb} ${cleanupSpacing(subject).toLowerCase()}`
  );
  return result;
}

function splitLongSentence(text) {
  const words = getWords(text);
  if (words.length <= 20) return [cleanupSpacing(text)];

  const preferredSplit = text.search(/\s(?:and|but|so)\s/i);
  if (preferredSplit > 25 && preferredSplit < text.length - 20) {
    const connectorMatch = text.slice(preferredSplit).match(/\s(and|but|so)\s/i);
    if (connectorMatch) {
      const connector = connectorMatch[1].toLowerCase();
      const [left, right] = [
        text.slice(0, preferredSplit),
        text.slice(preferredSplit + connectorMatch[0].length)
      ];
      return [
        ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(left))),
        ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(`${connector} ${right}`)))
      ];
    }
  }

  const midpoint = Math.floor(words.length / 2);
  const splitToken = words[midpoint];
  const splitIndex = text.toLowerCase().indexOf(splitToken.toLowerCase(), Math.floor(text.length / 3));
  if (splitIndex > 20) {
    const left = text.slice(0, splitIndex);
    const right = text.slice(splitIndex);
    return [
      ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(left))),
      ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(`So ${right}`)))
    ];
  }

  return [ensureTrailingPunctuation(sentenceCaseText(cleanupSpacing(text)))];
}

function humanizeSentence(sentence) {
  let result = normalizeWhitespace(sentence || '');
  if (!result) return '';

  result = replaceSimpleWords(result);
  result = humanizeConnectors(result);
  result = depassivizeSentence(result);
  result = applyPhraseReplacements(result, [
    [/\bplease be advised that\b/gi, ''],
    [/\bkindly\b/gi, 'please'],
    [/\bdo not hesitate to\b/gi, 'please'],
    [/\bwe would like to\b/gi, 'we want to']
  ]);

  const parts = splitLongSentence(result)
    .map((part) => cleanupSpacing(part))
    .filter(Boolean)
    .map((part) => ensureTrailingPunctuation(sentenceCaseText(part)));

  return cleanupSpacing(parts.join(' '));
}

function detectRepeatedSentences(sentences) {
  const repeated = [];
  const duplicateIndices = new Set();

  for (let i = 0; i < sentences.length; i += 1) {
    for (let j = i + 1; j < sentences.length; j += 1) {
      const similarity = jaccardSimilarity(getBigrams(sentences[i]), getBigrams(sentences[j]));
      if (similarity > 0.8) {
        duplicateIndices.add(j);
        repeated.push({
          text: cleanupSpacing(sentences[i].replace(/[.!?]+$/, '')),
          similarity: Number(similarity.toFixed(2)),
          indexA: i,
          indexB: j
        });
      }
    }
  }

  return { repeated, duplicateIndices };
}

function analyzeAndHumanizeText(text) {
  const source = String(text || '').trim();
  const sentences = splitSentences(source).map((sentence) => cleanupSpacing(sentence)).filter(Boolean);

  if (sentences.length === 0) {
    return {
      uniqueness_score: 1,
      repetition_score: 0,
      status: 'unique',
      repeated_sentences: [],
      humanized_text: ''
    };
  }

  const { repeated, duplicateIndices } = detectRepeatedSentences(sentences);
  const repeatedCount = repeated.length;
  const repetitionScore = Number((repeatedCount / Math.max(1, sentences.length - 1)).toFixed(2));
  const uniquenessScore = Number((1 - repetitionScore).toFixed(2));
  const status = uniquenessScore < 0.4 ? 'rejected' : uniquenessScore <= 0.7 ? 'flagged' : 'unique';

  const humanizedSentences = sentences
    .filter((sentence, index) => !duplicateIndices.has(index))
    .map((sentence) => humanizeSentence(sentence))
    .filter(Boolean);

  return {
    uniqueness_score: uniquenessScore,
    repetition_score: repetitionScore,
    status,
    repeated_sentences: repeated,
    humanized_text: cleanupSpacing(humanizedSentences.join(' '))
  };
}

function truncateSummarySentence(text, maxLength = 140) {
  const clean = cleanupSpacing(text || '');
  if (clean.length <= maxLength) return clean;
  const shortened = clean.slice(0, maxLength);
  const cutoff = shortened.lastIndexOf(' ');
  return `${(cutoff > 60 ? shortened.slice(0, cutoff) : shortened).trim()}...`;
}

function compressSummarySentence(sentence) {
  let result = cleanupSpacing(sentence || '');
  if (!result) return '';

  result = result
    .replace(/^\s*(per|according to)\s+[^,]+,\s*/i, '')
    .replace(/^\s*sources?\s+(said|added|claimed|reported)\s+that\s*/i, '')
    .replace(/\b(a report|reports?)\s+(has\s+)?(claimed|said|reported)\s+that\s*/i, '')
    .replace(/\bwhich\s+(quotes?|cites?)\s+[^,]+,\s*/i, '')
    .replace(/\bsource(s)?\s+(said|added)\s+that\s*/gi, '')
    .replace(/\b(it|this)\s+(reportedly|reportedly)\b/gi, '$1')
    .replace(/\bpotential\b/gi, 'possible')
    .replace(/\bcould lead to\b/gi, 'may bring')
    .replace(/\bare taking part in\b/gi, 'are in')
    .replace(/\bwithin which\b/gi, 'when')
    .replace(/\bhas claimed that\b/gi, '')
    .replace(/\bhas said that\b/gi, '');

  result = sentenceCaseText(cleanupSpacing(result));
  return truncateSummarySentence(ensureTrailingPunctuation(result));
}


function normalizeSummaryLines(content) {
  const seen = new Set();
  return String(content || '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .filter((line) => line.length >= 25)
    .filter((line) => !/^(advertisement|sponsored|share|copy link|sign in|log in|subscribe|follow us)$/i.test(line))
    .filter((line) => {
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function isLikelyHeading(line) {
  if (!line) return false;
  if (line.length > 80) return false;
  if (/[.!?]$/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 8) return false;
  return /^(?:[A-Z][\w&/-]*\s*)+$/.test(line) || /^[A-Z][A-Za-z\s&/-]+$/.test(line);
}

function scoreSummarySentence(sentence, index, titleWords) {
  const lower = sentence.toLowerCase();
  const words = lower.match(/\b[a-z]{3,}\b/g) || [];
  const uniqueWords = new Set(words);
  let score = uniqueWords.size;

  if (index < 3) score += 4;
  if (sentence.length >= 55 && sentence.length <= 180) score += 3;
  if (/\b(injury|availability|tactics|matchups|probable|record|confirmed|return|coach|captain|season|form)\b/i.test(sentence)) score += 3;

  if (titleWords?.size) {
    const overlap = [...uniqueWords].filter((word) => titleWords.has(word)).length;
    score += overlap * 2;
  }

  if (/[:|]/.test(sentence)) score += 2;
  if (sentence.length > 220) score -= 3;
  return score;
}

function buildBriefSummary(content) {
  const lines = normalizeSummaryLines(content);
  if (!lines.length) return 'No readable content found.';

  const title = lines.find(isLikelyHeading) || '';
  const bodyLines = title ? lines.filter((line, index) => index !== lines.indexOf(title)) : lines;
  const text = bodyLines.join(' ');

  const sentences = splitSentences(text)
    .map((sentence) => cleanupSpacing(sentence))
    .filter((sentence) => sentence.split(' ').length >= 7)
    .filter((sentence) => sentence.length <= 240);

  if (!sentences.length) {
    return truncateSummarySentence(text, 180);
  }

  const titleWords = new Set(
    (title.toLowerCase().match(/\b[a-z]{3,}\b/g) || []).filter((word) => !['the', 'and', 'for'].includes(word))
  );

  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreSummarySentence(sentence, index, titleWords)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);

  const parts = ranked
    .map((item) => truncateSummarySentence(compressSummarySentence(item.sentence), 110))
    .filter(Boolean);

  if (!parts.length) {
    return truncateSummarySentence(text, 180);
  }

  const shortTitle = title ? truncateSummarySentence(title, 55) : '';
  const introCore = parts[0].replace(/[.!?]+$/, '');
  const intro = shortTitle
    ? `${shortTitle}: ${introCore}.`
    : `In short: ${introCore}.`;
  const bullets = parts
    .slice(1, 3)
    .map((part) => part.replace(/^[•\-\s]+/, ''))
    .map((part) => `• ${part}`);

  return [intro, ...bullets].join('\n');
}

// On-device AI summary when available, extractive rules summary otherwise.
async function summarizeText(content) {
  const source = String(content || '').trim();
  if (!source) return 'No readable content found.';
  const ai = await aiProvider.run('summarize', source);
  if (ai != null) return ai;
  return buildBriefSummary(source);
}

async function getWritingScore(text) {
  const source = text || '';
  const words = source.match(/\b[\w']+\b/g) || [];
  const sentences = splitSentences(source);
  const grammarIssues = (await checkGrammar(source)).length;
  const avgSentenceLength = sentences.length ? words.length / sentences.length : words.length;
  const longSentencePenalty = avgSentenceLength > 24 ? 12 : avgSentenceLength > 18 ? 6 : 0;
  const shortSentenceBonus = avgSentenceLength >= 8 && avgSentenceLength <= 18 ? 6 : 0;
  const fillerPenalty = (source.match(/\b(very|really|actually|basically|just)\b/gi) || []).length * 2;

  const grammar = Math.max(45, 100 - grammarIssues * 9);
  const clarity = Math.max(40, 94 - longSentencePenalty - fillerPenalty + shortSentenceBonus);
  const engagement = Math.max(45, Math.min(95, 68 + (/[!?]/.test(source) ? 4 : 0) + (/\byou\b/i.test(source) ? 6 : 0) + (/\b(imagine|build|create|improve|discover)\b/i.test(source) ? 8 : 0)));
  const overall = Math.round((grammar * 0.4) + (clarity * 0.35) + (engagement * 0.25));

  let feedback = 'Strong baseline writing.';
  if (grammarIssues >= 3) feedback = 'Clean up grammar and spelling issues first for a stronger draft.';
  else if (clarity < 70) feedback = 'Shorter sentences and fewer filler words would improve clarity.';
  else if (engagement < 70) feedback = 'Stronger verbs and more direct phrasing would make this more engaging.';

  return { overall, grammar, clarity, engagement, feedback };
}

// ── Tone detection ──
const TONE_EMOJI = {
  Neutral: '😐', Friendly: '🙂', Formal: '🎩', Casual: '😎', Confident: '💪',
  Tentative: '🤔', Urgent: '⏰', Polite: '🙏', Excited: '🎉', Assertive: '📣',
  Positive: '✨', Negative: '⚠️', Apologetic: '😔', Analytical: '📊'
};

function labelToTone(label) {
  return { label, emoji: TONE_EMOJI[label] || '🗨️' };
}

function detectToneRules(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const scores = {};
  const bump = (k, n = 1) => { scores[k] = (scores[k] || 0) + n; };

  const excl = (t.match(/!/g) || []).length;
  if (excl) bump('Excited', excl);
  if (/\b(please|thank you|thanks|kindly|appreciate|grateful)\b/.test(lower)) bump('Polite', 2);
  if (/\b(asap|urgent|immediately|deadline|right away|by (?:today|tomorrow|eod))\b/.test(lower)) bump('Urgent', 2);
  if (/\b(i think|maybe|perhaps|might|possibly|not sure|hopefully|kind of|sort of|i guess)\b/.test(lower)) bump('Tentative', 2);
  if (/\b(will|must|need to|ensure|guarantee|definitely|clearly|certainly|confident|absolutely)\b/.test(lower)) bump('Confident', 2);
  const contractions = (lower.match(/\b\w+'(?:s|re|ll|ve|d|t|m)\b/g) || []).length;
  if (contractions || /\b(hey|yeah|gonna|wanna|cool|awesome|stuff|okay|ok)\b/.test(lower)) bump('Casual', 1 + contractions);
  if (/\b(therefore|however|furthermore|regarding|pursuant|hereby|accordingly|respectfully|sincerely)\b/.test(lower)) bump('Formal', 2);
  if (/\b(sorry|apolog|unfortunately|regret)\b/.test(lower)) bump('Apologetic', 2);
  const caps = (t.match(/\b[A-Z]{3,}\b/g) || []).length;
  if (caps) bump('Assertive', caps);
  if (/\b(great|love|excellent|fantastic|wonderful|glad|happy|excited|awesome|perfect)\b/.test(lower)) bump('Positive', 2);
  if (/\b(no|not|never|won'?t|can'?t|refuse|reject|bad|wrong|fail|problem|issue|concern)\b/.test(lower)) bump('Negative', 1);

  let tones = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  if (!tones.length) tones = ['Neutral'];

  let feedback = `Reads as ${tones.join(', ').toLowerCase()}.`;
  if (tones.includes('Tentative')) {
    feedback = 'Sounds tentative — trimming hedges like "maybe" or "I think" would read more confidently.';
  } else if (tones.includes('Assertive')) {
    feedback = 'The ALL-CAPS words read as shouting — normal case would feel calmer.';
  } else if (tones.includes('Urgent') && !tones.includes('Polite')) {
    feedback = 'Direct and urgent — a courteous line can soften the ask.';
  } else if (tones.includes('Negative') && !tones.includes('Polite')) {
    feedback = 'Leans negative — softening the wording may land better.';
  }

  return { tones: tones.map(labelToTone), feedback };
}

function parseToneOutput(raw) {
  const lines = String(raw || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return detectToneRules('');
  const labels = lines[0]
    .replace(/^tones?\s*:?\s*/i, '')
    .split(/[,/]| and /i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
  const tones = (labels.length ? labels : ['Neutral']).map(labelToTone);
  const feedback = lines.slice(1).join(' ') || `Reads as ${labels.join(', ').toLowerCase() || 'neutral'}.`;
  return { tones, feedback };
}

async function detectTone(text) {
  const source = String(text || '').trim();
  if (!source) return { tones: [], feedback: 'Enter some text to check its tone.' };
  const ai = await aiProvider.run('tone', source);
  if (ai != null) return parseToneOutput(ai);
  return detectToneRules(source);
}

// ── Readability (Flesch–Kincaid) ──
function countSyllables(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

const PASSIVE_RE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ed|written|done|made|said|seen|taken|given|known|found|held|kept|built|sent|shown|born|paid|told|left|felt|met|led|read|set|put|cut|run|won|begun|chosen|driven|eaten|fallen|forgotten|gotten|hidden|spoken|stolen|broken|drawn|grown|thrown|worn)\b/gi;

function analyzeReadability(text) {
  const src = String(text || '');
  const words = src.match(/\b[\w']+\b/g) || [];
  const sentences = splitSentences(src).filter((s) => s.trim());
  const wc = words.length;
  if (!wc) {
    return { grade: 0, readingEase: 0, level: '—', passivePct: 0, avgSentenceLen: 0, longSentences: 0, adverbs: 0, feedback: 'Enter some text to analyze.' };
  }
  const sc = Math.max(1, sentences.length);
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const wps = wc / sc;
  const spw = syllables / wc;
  const readingEase = Math.max(0, Math.min(100, Math.round(206.835 - 1.015 * wps - 84.6 * spw)));
  const grade = Math.max(0, Math.round((0.39 * wps + 11.8 * spw - 15.59) * 10) / 10);
  const passiveCount = (src.match(PASSIVE_RE) || []).length;
  const passivePct = Math.min(100, Math.round((passiveCount / sc) * 100));
  const longSentences = sentences.filter((s) => (s.match(/\b[\w']+\b/g) || []).length > 24).length;
  const adverbs = (src.match(/\b\w+ly\b/gi) || []).length;
  const level = readingEase >= 80 ? 'Very easy' : readingEase >= 60 ? 'Easy' : readingEase >= 45 ? 'Fairly hard' : readingEase >= 30 ? 'Hard' : 'Very hard';

  let feedback = 'Clear and readable.';
  if (longSentences) feedback = `${longSentences} long sentence${longSentences > 1 ? 's' : ''} (24+ words) — splitting them improves clarity.`;
  else if (passivePct >= 25) feedback = `${passivePct}% passive voice — active voice reads stronger.`;
  else if (grade > 12) feedback = 'Dense wording — simpler words would lower the reading grade.';

  return { grade, readingEase, level, passivePct, avgSentenceLen: Math.round(wps * 10) / 10, longSentences, adverbs, feedback };
}

// ── Translation (on-device AI; no rules fallback) ──
const LANG_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', en: 'English',
  hi: 'Hindi', zh: 'Chinese', ar: 'Arabic', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ko: 'Korean'
};

async function translateText(text, target) {
  const source = String(text || '').trim();
  if (!source) return { ok: false, error: 'Enter some text to translate.' };
  const lang = LANG_NAMES[target] || target || 'English';
  const ai = await aiProvider.run('translate', source, { lang });
  if (ai != null) return { ok: true, text: ai, lang };
  return { ok: false, error: 'On-device AI is needed for translation. Turn it on in Settings, or use a Chrome version with built-in AI.' };
}

// ── Synonyms (AI + small built-in fallback) ──
const SYNONYM_MAP = {
  good: ['great', 'excellent', 'fine', 'solid', 'strong'],
  bad: ['poor', 'subpar', 'weak', 'flawed', 'lousy'],
  big: ['large', 'huge', 'sizable', 'massive', 'vast'],
  small: ['tiny', 'little', 'compact', 'minor', 'slight'],
  happy: ['glad', 'pleased', 'content', 'cheerful', 'delighted'],
  sad: ['unhappy', 'down', 'gloomy', 'dejected'],
  important: ['key', 'crucial', 'vital', 'significant', 'essential'],
  help: ['assist', 'aid', 'support', 'guide'],
  use: ['utilize', 'employ', 'apply', 'leverage'],
  make: ['create', 'build', 'produce', 'form'],
  fast: ['quick', 'rapid', 'swift', 'speedy'],
  slow: ['sluggish', 'gradual', 'leisurely'],
  said: ['stated', 'noted', 'mentioned', 'remarked', 'explained'],
  very: ['extremely', 'highly', 'remarkably', 'especially'],
  get: ['obtain', 'acquire', 'receive', 'gain'],
  show: ['display', 'reveal', 'demonstrate', 'present'],
  think: ['believe', 'consider', 'reckon', 'suppose'],
  new: ['fresh', 'novel', 'recent', 'modern'],
  old: ['aged', 'former', 'dated', 'vintage'],
  hard: ['difficult', 'tough', 'challenging', 'demanding'],
  easy: ['simple', 'effortless', 'straightforward'],
  nice: ['pleasant', 'lovely', 'agreeable', 'kind'],
  want: ['wish', 'desire', 'need', 'crave'],
  start: ['begin', 'launch', 'initiate', 'kick off'],
  end: ['finish', 'conclude', 'complete', 'wrap up']
};

async function getSynonyms(word) {
  const w = String(word || '').trim();
  if (!w || /\s/.test(w)) return [];
  const ai = await aiProvider.run('synonyms', w);
  if (ai != null) {
    return ai.split(/[,\n]/)
      .map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim())
      .filter(Boolean)
      .filter((s) => s.toLowerCase() !== w.toLowerCase())
      .slice(0, 6);
  }
  return (SYNONYM_MAP[w.toLowerCase()] || []).slice(0, 6);
}

// ── Sentence completion (autocomplete; AI only) ──
async function completeText(text) {
  const source = String(text || '');
  if (source.trim().length < 12) return '';
  const ai = await aiProvider.run('complete', source.slice(-600));
  if (ai == null) return '';
  // Model must only return the continuation; keep it short and single-line.
  let out = ai.split('\n')[0].trim();
  if (out.toLowerCase().startsWith(source.trim().slice(-40).toLowerCase())) out = '';
  return out.slice(0, 120);
}

function parseDateKeyword(lower) {
  const now = new Date();
  const result = new Date(now);
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  if (lower.includes('today')) return now.toISOString().split('T')[0];
  if (lower.includes('tomorrow')) {
    result.setDate(result.getDate() + 1);
    return result.toISOString().split('T')[0];
  }
  if (lower.includes('tonight')) return now.toISOString().split('T')[0];

  const relative = lower.match(/\bin (\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (relative) {
    const amount = parseInt(relative[1], 10);
    const unit = relative[2];
    if (unit.startsWith('day')) result.setDate(result.getDate() + amount);
    else if (unit.startsWith('week')) result.setDate(result.getDate() + amount * 7);
    else result.setMonth(result.getMonth() + amount);
    return result.toISOString().split('T')[0];
  }

  const nextWeekday = lower.match(/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (nextWeekday) {
    const target = weekdays.indexOf(nextWeekday[1]);
    const current = now.getDay();
    let diff = (target - current + 7) % 7;
    if (diff === 0 || lower.includes(`next ${nextWeekday[1]}`)) diff += 7;
    result.setDate(result.getDate() + diff);
    return result.toISOString().split('T')[0];
  }

  return null;
}

function parseTimeKeyword(lower) {
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2] || '0', 10);
    const meridiem = timeMatch[3];
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  if (/\bmorning\b/.test(lower)) return '09:00';
  if (/\bafternoon\b/.test(lower)) return '14:00';
  if (/\bevening\b/.test(lower)) return '18:00';
  if (/\btonight\b/.test(lower)) return '20:00';

  return null;
}

function parseRecurring(lower) {
  if (/\bevery day\b|\bdaily\b/.test(lower)) return { pattern: 'daily', interval: 1 };
  if (/\bevery week\b|\bweekly\b/.test(lower)) return { pattern: 'weekly', interval: 1 };
  if (/\bevery month\b|\bmonthly\b/.test(lower)) return { pattern: 'monthly', interval: 1 };

  const everyN = lower.match(/\bevery\s+(\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (everyN) {
    const interval = parseInt(everyN[1], 10);
    const unit = everyN[2];
    if (unit.startsWith('day')) return { pattern: 'daily', interval };
    if (unit.startsWith('week')) return { pattern: 'weekly', interval };
    return { pattern: 'monthly', interval };
  }

  return null;
}

function parsePriority(lower) {
  if (/\bp1\b|\burgent\b|\bcritical\b|\basap\b/.test(lower)) return 'P1';
  if (/\bp2\b|\bhigh priority\b|\bimportant\b/.test(lower)) return 'P2';
  if (/\bp3\b|\bmedium\b/.test(lower)) return 'P3';
  return 'P4';
}

function parseLabels(text) {
  return Array.from(new Set((text.match(/#([a-z0-9_-]+)/gi) || []).map((item) => item.slice(1))));
}

// Combine a parsed date (YYYY-MM-DD) and time (HH:MM) into a reminder ISO string.
function buildReminderFromParts(dateStr, timeStr) {
  if (!dateStr && !timeStr) return null;
  const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return null;

  if (timeStr) {
    const [hour, minute] = timeStr.split(':').map(Number);
    base.setHours(hour, minute, 0, 0);
  } else {
    base.setHours(9, 0, 0, 0); // default to 9:00 AM when only a date is given
  }

  // If only a time-of-day was given and it already passed today, roll to tomorrow.
  if (!dateStr && timeStr && base.getTime() <= Date.now()) {
    base.setDate(base.getDate() + 1);
  }

  return base.toISOString();
}

function parseNaturalLanguageTask(text) {
  const source = normalizeWhitespace(text || '');
  const lower = source.toLowerCase();
  const labels = parseLabels(source);
  const priority = parsePriority(lower);
  const dueDate = parseDateKeyword(lower);
  const dueTime = parseTimeKeyword(lower);
  const recurring = parseRecurring(lower);

  let reminderAt = buildReminderFromParts(dueDate, dueTime);
  // A recurring task with no explicit time still needs a first fire time.
  if (!reminderAt && recurring) {
    reminderAt = buildReminderFromParts(null, '09:00');
  }

  let title = source
    .replace(/#([a-z0-9_-]+)/gi, '')
    .replace(/\bin \d+\s+(?:days?|weeks?|months?)\b/gi, '')
    .replace(/\bevery\s+\d+\s+(?:days?|weeks?|months?)\b/gi, '')
    .replace(/\b(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, '')
    .replace(/\b(today|tomorrow|tonight|morning|afternoon|evening|daily|weekly|monthly|every day|every week|every month|urgent|critical|important|asap|p1|p2|p3|p4|high priority|medium)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();

  if (!title) title = source;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return {
    title,
    description: null,
    priority,
    labels,
    recurring,
    dueDate,
    dueTime,
    reminderAt
  };
}

// ── Extract action items from arbitrary text (emails, notes, docs) ──

const ACTION_CUE_RE = /\b(need to|needs to|have to|has to|must|should|to-?do|follow[- ]?up|remember to|don'?t forget|make sure|please|action item|assign(?:ed)?|deadline|due|schedule|send|email|call|review|prepare|book|submit|fix|update|create|draft|confirm|order|pay|sign|deliver|finish|complete|set up|arrange|contact|reply|respond)\b/i;
const IMPERATIVE_START_RE = /^(send|email|call|review|prepare|book|submit|fix|update|create|draft|confirm|order|pay|sign|deliver|finish|complete|schedule|arrange|contact|reply|respond|buy|write|check|plan|set|add|remove|ask|tell|remind|follow|build|test|deploy|research|read|share|invite|renew|cancel|approve)\b/i;

function extractActionItemsRules(text) {
  const src = String(text || '');
  const out = [];

  // 1. Explicit bullet / numbered / checkbox lines.
  src.split(/\n+/).forEach((line) => {
    const l = line.trim();
    if (l && /^([-*••]|\[\s?\]|\d+[.)])\s+/.test(l)) out.push(l);
  });

  // 2. Sentences that start with an imperative verb or carry an action cue.
  const sentences = src.replace(/[ \t]+/g, ' ').match(/[^.!?\n]+[.!?]?/g) || [];
  sentences.forEach((s) => {
    const t = s.trim();
    if (t.length >= 4 && (IMPERATIVE_START_RE.test(t) || ACTION_CUE_RE.test(t))) out.push(t);
  });

  return out;
}

function tidyTaskTitle(title) {
  let t = String(title || '')
    .replace(/^(please|also|and|kindly|then)\s+/i, '')
    .replace(/^(we|i|you|they)\s+(need to|needs to|have to|has to|must|should|want to)\s+/i, '')
    .replace(/^(remember to|don'?t forget to|make sure to|need to|have to|to)\s+/i, '')
    .replace(/\s+(by|on|at|for|to|before|until)\s*[.,]?$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.!]+$/, '')
    .trim();
  if (!t) t = String(title || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

async function extractTasks(text) {
  const source = String(text || '').trim();
  if (!source) return [];

  const ai = await aiProvider.run('extractTasks', source);
  const rawLines = ai != null ? ai.split(/\n+/) : extractActionItemsRules(source);

  const items = [];
  const seen = new Set();
  for (const raw of rawLines) {
    // Strip list markers/checkboxes the model or source may include.
    const clean = String(raw || '')
      .replace(/^[\s\-*••\d.)\]]+/, '')
      .replace(/^\[\s?[xX]?\s?\]\s*/, '')
      .trim();
    if (clean.length < 3) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const parsed = parseNaturalLanguageTask(clean);
    items.push({
      title: tidyTaskTitle(parsed.title),
      raw: clean,
      priority: parsed.priority,
      labels: parsed.labels,
      dueDate: parsed.dueDate,
      dueTime: parsed.dueTime,
      reminderAt: parsed.reminderAt,
      recurring: parsed.recurring
    });
    if (items.length >= 25) break;
  }

  return items;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + (minutes * 60 * 1000));
}

function nextWeekdayTime(hour, minute) {
  const candidate = new Date();
  candidate.setHours(hour, minute, 0, 0);
  if (candidate <= new Date()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }
  return candidate;
}

function buildRecurringReminder(kind, durationMinutes) {
  if (kind === 'water' || kind === 'screen') {
    return { pattern: 'interval', intervalMinutes: durationMinutes };
  }
  return null;
}

function buildTimeReminder(kind, timeSlot) {
  if ((kind === 'tea' || kind === 'lunch') && timeSlot) {
    return { pattern: 'slots', times: [timeSlot] };
  }
  return null;
}

function buildTaskSchedule(taskInput, fromDate = new Date()) {
  const kind = taskInput.kind || 'task';
  const durationMinutes = Math.max(15, Math.min(180, Number(taskInput.durationMinutes) || 15));
  const timeSlot = taskInput.timeSlot || null;
  const slotReminder = buildTimeReminder(kind, timeSlot);
  const recurring = taskInput.recurrenceMode === 'recurring'
    ? (slotReminder || buildRecurringReminder(kind, durationMinutes))
    : null;

  const reminderDate = recurring
    ? getNextRecurringReminder({ recurring, durationMinutes }, fromDate)
    : slotReminder
      ? getNextRecurringReminder({ recurring: slotReminder, durationMinutes }, fromDate)
      : addMinutes(fromDate, durationMinutes);

  return {
    durationMinutes,
    timeSlot,
    recurring,
    reminderAt: reminderDate ? reminderDate.toISOString() : null
  };
}

function addPeriod(date, pattern, interval) {
  const next = new Date(date);
  if (pattern === 'daily') next.setDate(next.getDate() + interval);
  else if (pattern === 'weekly') next.setDate(next.getDate() + 7 * interval);
  else if (pattern === 'monthly') next.setMonth(next.getMonth() + interval);
  return next;
}

function getNextRecurringReminder(task, fromDate = new Date()) {
  if (!task.recurring) return null;

  if (task.recurring.pattern === 'interval') {
    return addMinutes(fromDate, task.recurring.intervalMinutes || task.durationMinutes || 30);
  }

  // Calendar recurrence from natural-language input (e.g. "every day", "weekly").
  if (['daily', 'weekly', 'monthly'].includes(task.recurring.pattern)) {
    const interval = task.recurring.interval || 1;
    let next = task.reminderAt ? new Date(task.reminderAt) : new Date(fromDate);
    if (Number.isNaN(next.getTime())) next = new Date(fromDate);
    let guard = 0;
    while (next.getTime() <= fromDate.getTime() && guard < 1000) {
      next = addPeriod(next, task.recurring.pattern, interval);
      guard += 1;
    }
    return next;
  }

  if (task.recurring.pattern === 'slots') {
    const slots = task.recurring.times || [];
    for (const slot of slots) {
      const [hour, minute] = slot.split(':').map(Number);
      const candidate = new Date(fromDate);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate > fromDate && candidate.getDay() !== 0 && candidate.getDay() !== 6) {
        return candidate;
      }
    }
    const [hour, minute] = (slots[0] || '09:00').split(':').map(Number);
    return nextWeekdayTime(hour, minute);
  }

  return null;
}

function getReminderTitle(task) {
  const titles = {
    focus: 'WriteTask Pro — Focus time',
    water: 'WriteTask Pro — Water break',
    screen: 'WriteTask Pro — Screen break',
    tea: 'WriteTask Pro — Tea break',
    lunch: 'WriteTask Pro — Lunch break',
    task: 'WriteTask Pro — Reminder'
  };
  return titles[task.kind] || titles.task;
}

function getReminderMessage(task) {
  const defaults = {
    focus: 'Time to get back into focused work.',
    water: 'Take a minute to drink water and reset.',
    screen: 'Look away, stretch a little, and rest your eyes.',
    tea: 'Step away for a quick tea break.',
    lunch: 'Pause and take your lunch break.',
    task: 'Your reminder is ready.'
  };
  return task.title || defaults[task.kind] || defaults.task;
}

function buildReminderPayload(task) {
  return {
    id: task.id,
    kind: task.kind,
    title: getReminderTitle(task),
    message: getReminderMessage(task)
  };
}

// Fire a real OS notification (survives when the tab/sidebar isn't focused).
function showOsNotification(task) {
  try {
    const payload = buildReminderPayload(task);
    chrome.notifications.create(`reminder-${task.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: payload.title,
      message: payload.message,
      priority: 2,
      requireInteraction: true,
      buttons: [
        { title: task.kind === 'task' ? 'Mark done' : 'Got it' },
        { title: 'Snooze 15m' }
      ]
    });
  } catch { /* notifications unavailable */ }
}

chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  if (!id.startsWith('reminder-')) return;
  const taskId = id.replace('reminder-', '');
  chrome.notifications.clear(id);
  try {
    if (idx === 1) { await extendTaskReminder(taskId, 15); return; }
    const tasks = await getTasksFromStorage();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.kind === 'task') await completeTask(taskId);
    else await clearReminderAttention(taskId);
  } catch { /* noop */ }
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('reminder-')) return;
  const taskId = id.replace('reminder-', '');
  chrome.notifications.clear(id);
  try { await clearReminderAttention(taskId); } catch { /* noop */ }
});

async function updateActionBadge(tasksInput = null) {
  const tasks = tasksInput || await getTasksFromStorage();
  const readyTasks = tasks.filter((task) => !task.completed && task.attentionNeeded);
  const attentionCount = readyTasks.length;
  await chrome.action.setBadgeBackgroundColor({ color: attentionCount > 0 ? '#ef4444' : '#6366f1' });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: attentionCount > 0 ? String(Math.min(attentionCount, 99)) : '' });
  await chrome.action.setTitle({
    title: attentionCount > 0
      ? `WriteTask Pro (${attentionCount} reminder${attentionCount === 1 ? '' : 's'} ready${readyTasks[0]?.title ? `: ${readyTasks[0].title}` : ''})`
      : 'WriteTask Pro'
  });
}

async function clearReminderAttention(taskId = null) {
  const tasks = await getTasksFromStorage();
  let changed = false;
  tasks.forEach((task) => {
    if (task.completed || !task.attentionNeeded) return;
    if (!taskId || task.id === taskId) {
      task.attentionNeeded = false;
      changed = true;
    }
  });
  if (changed) {
    await saveTasksToStorage(tasks);
  }
  await updateActionBadge(tasks);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name.startsWith('task-reminder-')) {
      const taskId = alarm.name.replace('task-reminder-', '');
      const tasks = await getTasksFromStorage();
      const task = tasks.find((item) => item.id === taskId);
      if (task && !task.completed) {
        const reminderPayload = buildReminderPayload(task);
        task.attentionNeeded = true;
        await saveTasksToStorage(tasks);
        await updateActionBadge(tasks);
        broadcastMessage({ action: 'reminderTriggered', task: reminderPayload });
        showOsNotification(task);
        if (task.recurring) {
          const nextReminder = getNextRecurringReminder(task, new Date());
          if (nextReminder) {
            task.reminderAt = nextReminder.toISOString();
            await saveTasksToStorage(tasks);
            await updateActionBadge(tasks);
            scheduleTaskReminder(task);
            broadcastMessage({ action: 'tasksUpdated' });
          }
        }
      }
    }
  } catch (err) {
    console.error('WriteTask Pro alarm error:', err);
  }
});

async function getTasksFromStorage() {
  const result = await chrome.storage.local.get(['wtp_tasks']);
  return result.wtp_tasks || [];
}

async function saveTasksToStorage(tasks) {
  await chrome.storage.local.set({ wtp_tasks: tasks });
}

async function completeTask(taskId) {
  const tasks = await getTasksFromStorage();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;

  chrome.alarms.clear(`task-reminder-${taskId}`);
  task.completed = true;
  task.completedAt = new Date().toISOString();
  await saveTasksToStorage(tasks);
  await updateActionBadge(tasks);

  broadcastMessage({ action: 'tasksUpdated' });
}

function scheduleTaskReminder(task) {
  chrome.alarms.clear(`task-reminder-${task.id}`);
  if (!task.reminderAt) return;
  const when = new Date(task.reminderAt).getTime();
  if (when > Date.now()) chrome.alarms.create(`task-reminder-${task.id}`, { when });
}

async function extendTaskReminder(taskId, minutes) {
  const tasks = await getTasksFromStorage();
  const task = tasks.find((item) => item.id === taskId);
  if (!task || task.completed) return;

  const base = task.reminderAt ? new Date(task.reminderAt) : new Date();
  const start = base.getTime() > Date.now() ? base : new Date();
  task.reminderAt = addMinutes(start, minutes).toISOString();
  task.durationMinutes = minutes;
  task.attentionNeeded = false;
  await saveTasksToStorage(tasks);
  await updateActionBadge(tasks);
  scheduleTaskReminder(task);
  broadcastMessage({ action: 'tasksUpdated' });
}

function broadcastMessage(message) {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    if (!tabs) return;
    tabs.forEach((tab) => {
      if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (request.action) {
        case 'checkGrammar':
          return checkGrammar(request.text);
        case 'fixGrammar':
          return correctText(request.text);
        case 'paraphrase':
          return paraphraseText(request.text, request.mode);
        case 'analyzeHumanizeText':
          return analyzeAndHumanizeText(request.text);
        case 'summarize':
          return summarizeText(request.content);
        case 'writingScore':
          return getWritingScore(request.text);
        case 'detectTone':
          return detectTone(request.text);
        case 'readability':
          return analyzeReadability(request.text);
        case 'translate':
          return translateText(request.text, request.target);
        case 'synonyms':
          return getSynonyms(request.word);
        case 'complete':
          return completeText(request.text);
        case 'getDictionary': {
          const res = await chrome.storage.local.get(['wtp_dictionary']);
          return res.wtp_dictionary || [];
        }
        case 'addDictionaryWord':
          return addDictionaryWord(request.word);
        case 'removeDictionaryWord':
          return removeDictionaryWord(request.word);
        case 'aiStatus':
          return aiProvider.status();
        case 'setAiEnabled':
          aiProvider.setEnabled(request.enabled);
          return aiProvider.status();
        case 'parseTask':
          return parseNaturalLanguageTask(request.text);
        case 'extractTasks':
          return extractTasks(request.text);
        case 'createTask': {
          const tasks = await getTasksFromStorage();
          const schedule = buildTaskSchedule(request.task, new Date());
          // Prefer a reminder/recurrence parsed from natural language
          // (e.g. "email Sam tomorrow 3pm", "water #health every day").
          const reminderAt = request.task.reminderAt || schedule.reminderAt;
          const recurring = request.task.recurring || schedule.recurring;
          const recurrenceMode = request.task.recurring ? 'recurring' : (request.task.recurrenceMode || 'once');
          const task = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            title: request.task.title,
            description: request.task.description || '',
            reminderAt,
            durationMinutes: schedule.durationMinutes,
            kind: request.task.kind || 'task',
            timeSlot: schedule.timeSlot,
            priority: request.task.priority || 'P4',
            labels: request.task.labels || [],
            project: request.task.project || 'Inbox',
            subtasks: request.task.subtasks || [],
            recurring,
            recurrenceMode,
            status: 'todo',
            completed: false,
            completedAt: null,
            attentionNeeded: false,
            createdAt: new Date().toISOString(),
            sourceUrl: request.task.sourceUrl || null
          };
          tasks.push(task);
          await saveTasksToStorage(tasks);
          await updateActionBadge(tasks);
          scheduleTaskReminder(task);
          broadcastMessage({ action: 'tasksUpdated' });
          return task;
        }
        case 'updateTask': {
          const tasks = await getTasksFromStorage();
          const idx = tasks.findIndex((task) => task.id === request.taskId);
          if (idx !== -1) {
            Object.assign(tasks[idx], request.updates);
            const needsReschedule = ['title', 'kind', 'priority', 'durationMinutes', 'recurrenceMode', 'timeSlot'].some((key) => Object.prototype.hasOwnProperty.call(request.updates || {}, key));
            if (needsReschedule) {
              const schedule = buildTaskSchedule(tasks[idx], new Date());
              tasks[idx].durationMinutes = schedule.durationMinutes;
              tasks[idx].timeSlot = schedule.timeSlot;
              tasks[idx].recurring = schedule.recurring;
              tasks[idx].reminderAt = schedule.reminderAt;
              tasks[idx].attentionNeeded = false;
            }
            await saveTasksToStorage(tasks);
            await updateActionBadge(tasks);
            scheduleTaskReminder(tasks[idx]);
            broadcastMessage({ action: 'tasksUpdated' });
            return tasks[idx];
          }
          return null;
        }
        case 'deleteTask': {
          let tasks = await getTasksFromStorage();
          tasks = tasks.filter((task) => task.id !== request.taskId);
          await saveTasksToStorage(tasks);
          await updateActionBadge(tasks);
          chrome.alarms.clear(`task-reminder-${request.taskId}`);
          broadcastMessage({ action: 'tasksUpdated' });
          return true;
        }
        case 'completeTask':
          await completeTask(request.taskId);
          return true;
        case 'acknowledgeReminders':
          if (request.taskId) {
            await clearReminderAttention(request.taskId);
          }
          return true;
        case 'getTasks':
          return getTasksFromStorage();
        case 'rescheduleAll': {
          const tasks = await getTasksFromStorage();
          tasks.forEach((t) => { if (!t.completed) scheduleTaskReminder(t); });
          await updateActionBadge(tasks);
          broadcastMessage({ action: 'tasksUpdated' });
          return true;
        }
        default:
          return { error: 'Unknown action' };
      }
    } catch (err) {
      return { error: err.message };
    }
  };

  handler().then(sendResponse);
  return true;
});

updateActionBadge().catch(() => {});

// Apply the saved "writing engine" preference (Auto on-device AI vs. Rules only).
chrome.storage.local.get(['wtp_settings'])
  .then((res) => {
    const engine = res?.wtp_settings?.aiEngine;
    aiProvider.setEnabled(engine !== 'off');
  })
  .catch(() => {});
