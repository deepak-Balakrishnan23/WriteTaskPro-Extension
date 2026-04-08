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
    chrome.contextMenus.create({ id: 'writetask-summarize', title: 'WriteTask Pro: Summarize Page', contexts: ['page'] });
  });

  chrome.storage.local.get(['wtp_settings'], (result) => {
    if (!result.wtp_settings) {
      chrome.storage.local.set({
        wtp_settings: {
          theme: 'system'
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
  else if (info.menuItemId === 'writetask-summarize') send({ action: 'contextMenuSummarize' });
});

const AI_RUNTIME_CONFIG = {
  modelId: 'flan-t5-small',
  modelsBaseUrl: chrome.runtime.getURL('models/'),
  wasmBaseUrl: chrome.runtime.getURL('vendor/'),
  runtimeUrl: chrome.runtime.getURL('vendor/transformers.web.js')
};

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreenDocument = null;
let aiInitPromise = null;

async function ensureOffscreenDocument(path = OFFSCREEN_DOCUMENT_PATH) {
  const offscreenUrl = chrome.runtime.getURL(path);

  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: path,
    reasons: ['WORKERS'],
    justification: 'Host a dedicated AI worker for local ONNX text generation.'
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const port = chrome.runtime.connect({ name: 'ai-offscreen' });

    const cleanup = () => {
      try {
        port.disconnect();
      } catch { }
    };

    port.onMessage.addListener((response) => {
      if (!response || response.requestId !== requestId) return;
      cleanup();
      if (response.ok) resolve(response.data);
      else reject(response.error);
    });

    port.onDisconnect.addListener(() => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject({
          code: 'OFFSCREEN_DISCONNECTED',
          message: runtimeError.message
        });
      }
    });

    port.postMessage({ ...message, requestId });
  });
}

async function initAiModel() {
  if (aiInitPromise) return aiInitPromise;

  aiInitPromise = sendToOffscreen({ action: 'ai:init', config: AI_RUNTIME_CONFIG })
    .then((result) => result)
    .catch((error) => {
      aiInitPromise = null;
      throw error;
    });

  return aiInitPromise;
}

async function runAiInference(payload) {
  await initAiModel();
  return sendToOffscreen({
    action: 'ai:run',
    text: payload.text,
    mode: payload.mode || null,
    task: payload.task || 'rewrite'
  });
}

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

const TOKEN_CORRECTIONS = {
  heloo: 'hello',
  helow: 'hello',
  helooo: 'hello',
  heloow: 'hello',
  heloww: 'hello',
  heloowyou: 'hello you',
  hellowyou: 'hello you',
  helloyou: 'hello you',
  wnat: 'want',
  wnatfood: 'want food',
  wannafood: 'want food',
  u: 'you',
  ur: 'your'
};

const SPLIT_WORDS = new Set([
  'a', 'am', 'approve', 'approval', 'are', 'food', 'good', 'hello', 'help',
  'holiday', 'how', 'i', 'leave', 'me', 'my', 'need', 'now', 'please',
  'request', 'thanks', 'today', 'want', 'you', 'your'
]);

function splitMergedToken(token) {
  const lower = token.toLowerCase();
  const length = lower.length;
  const best = new Array(length + 1).fill(null);
  best[0] = [];

  for (let i = 0; i < length; i += 1) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= Math.min(length, i + 10); j += 1) {
      const chunk = lower.slice(i, j);
      if (!SPLIT_WORDS.has(chunk)) continue;
      const candidate = [...best[i], chunk];
      if (!best[j] || candidate.length < best[j].length) {
        best[j] = candidate;
      }
    }
  }

  if (!best[length] || best[length].length < 2) return token;

  const rebuilt = best[length]
    .map((word, index) => {
      if (index === 0 && token[0] === token[0]?.toUpperCase()) return titleCase(word);
      return word;
    })
    .join(' ');

  return rebuilt;
}

function normalizeTokens(text) {
  return String(text || '').replace(/\b[a-zA-Z]{2,}\b/g, (token) => {
    const corrected = TOKEN_CORRECTIONS[token.toLowerCase()];
    if (corrected) {
      if (token[0] === token[0].toUpperCase()) {
        return corrected.replace(/\b([a-z])/g, (match, letter, offset) => offset === 0 ? letter.toUpperCase() : letter);
      }
      return corrected;
    }
    return splitMergedToken(token);
  });
}

function applyCoreCorrections(text) {
  let result = normalizeTokens(normalizeWhitespace(text))
    .replace(/\bi am\b/gi, 'I am')
    .replace(/\bim\b/gi, "I'm")
    .replace(/\bi\b/g, 'I')
    .replace(/\bpls\b/gi, 'please')
    .replace(/\bthx\b/gi, 'thanks');

  COMMON_REPLACEMENTS.forEach(([original, suggestion]) => {
    result = replaceWholeWord(result, original, suggestion);
  });

  result = applyPhraseReplacements(result, [
    [/\bwant holiday approve\b/gi, 'want holiday approval'],
    [/\bneed holiday approve\b/gi, 'need holiday approval'],
    [/\bholiday approve\b/gi, 'holiday approval'],
    [/\bleave approve\b/gi, 'leave approval'],
    [/\bapprove my holiday\b/gi, 'approve my holiday request'],
    [/\bi want leave\b/gi, 'I want leave approval'],
    [/\bi need leave\b/gi, 'I need leave approval'],
    [/\bi want holiday\b/gi, 'I want holiday approval'],
    [/\bi need holiday\b/gi, 'I need holiday approval'],
    [/\bcan you approve\b/gi, 'could you approve'],
    [/\bkindly approve\b/gi, 'please approve']
  ]);

  result = cleanupSpacing(sentenceCaseText(result));
  return ensureTrailingPunctuation(result);
}

function findVerbProblem(text) {
  const source = normalizeWhitespace(text);
  if (!source) return null;

  const patterns = [
    {
      regex: /\b(want|need)\s+leave\b/i,
      replacement: (match, verb) => `${verb} to leave`,
      suggestion: 'to leave',
      explanation: 'This verb usually needs “to” before the next verb.'
    },
    {
      regex: /\b(want|need)\s+go\b/i,
      replacement: (match, verb) => `${verb} to go`,
      suggestion: 'to go',
      explanation: 'This verb usually needs “to” before the next verb.'
    },
    {
      regex: /\b(want|need)\s+take\s+leave\b/i,
      replacement: (match, verb) => `${verb} to take leave`,
      suggestion: 'to take leave',
      explanation: 'This phrase reads more naturally with “to take leave.”'
    },
    {
      regex: /\b(want|need)\s+holiday\b/i,
      replacement: (match, verb) => `${verb} a holiday`,
      suggestion: 'a holiday',
      explanation: 'This noun phrase usually needs an article.'
    }
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern.regex);
    if (!match) continue;

    const correctedSentence = ensureTrailingPunctuation(
      cleanupSpacing(sentenceCaseText(source.replace(pattern.regex, pattern.replacement)))
    );

    return {
      original: match[0],
      suggestion: pattern.suggestion,
      replacement: correctedSentence,
      rule: 'Verb problem',
      explanation: pattern.explanation
    };
  }

  return null;
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

function checkGrammar(text) {
  const errors = [];
  const rawText = text || '';
  const trimmed = rawText.trim();
  const correctedText = applyStandardRewrite(rawText);

  if (!trimmed) return [];

  const verbProblem = findVerbProblem(rawText);
  if (verbProblem) {
    errors.push(verbProblem);
  }

  const repeatedWords = rawText.match(/\b(\w+)\s+\1\b/gi) || [];
  repeatedWords.forEach((match) => {
    const word = match.split(/\s+/)[0];
    errors.push({
      original: match,
      suggestion: word,
      rule: 'Repeated word',
      explanation: 'The same word appears twice in a row.'
    });
  });

  if (/\s{2,}/.test(rawText)) {
    errors.push({
      original: 'Multiple spaces',
      suggestion: 'Use a single space',
      rule: 'Spacing',
      explanation: 'Extra spaces make text harder to read and can break formatting.'
    });
  }

  const sentences = splitSentences(rawText);
  sentences.forEach((sentence) => {
    const firstLetter = sentence.match(/[A-Za-z]/);
    if (firstLetter) {
      const ch = firstLetter[0];
      if (ch === ch.toLowerCase()) {
        errors.push({
          original: sentence.slice(0, Math.min(sentence.length, 40)),
          suggestion: titleCase(sentence),
          rule: 'Capitalization',
          explanation: 'Sentences should usually begin with a capital letter.'
        });
      }
    }

    if (!/[.!?]["')\]]?$/.test(sentence) && sentence.split(' ').length > 3) {
      errors.push({
        original: sentence.slice(0, Math.min(sentence.length, 40)),
        suggestion: `${sentence}.`,
        rule: 'Punctuation',
        explanation: 'This sentence appears to be missing end punctuation.'
      });
    }
  });

  if (/\bi\b/.test(rawText)) {
    errors.push({
      original: 'i',
      suggestion: 'I',
      rule: 'Capitalization',
      explanation: 'The pronoun “I” should always be capitalized.'
    });
  }

  COMMON_REPLACEMENTS.forEach(([original, suggestion, rule, explanation]) => {
    const regex = new RegExp(`\\b${escapeRegExp(original)}\\b`, 'i');
    if (regex.test(rawText)) {
      errors.push({ original, suggestion, rule, explanation });
    }
  });

  if (/\b(very|really|actually|basically|literally)\b/gi.test(rawText)) {
    errors.push({
      original: 'Filler words',
      suggestion: 'Trim unnecessary intensifiers',
      rule: 'Clarity',
      explanation: 'Words like “very” or “actually” can weaken concise writing.'
    });
  }

  if (
    correctedText &&
    cleanupSpacing(rawText) !== cleanupSpacing(correctedText) &&
    !verbProblem
  ) {
    errors.unshift({
      original: rawText,
      suggestion: correctedText,
      rule: 'Suggested correction',
      explanation: 'A stronger local correction was generated for the full sentence.'
    });
  }

  return errors.slice(0, 12);
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
  result = result.replace(/\bI want holiday approval\b/i, 'I want my holiday approved');
  result = result.replace(/\bI need holiday approval\b/i, 'I need my holiday approved');
  result = result.replace(/\bI want leave approval\b/i, 'I want my leave approved');
  result = result.replace(/\bI need leave approval\b/i, 'I need my leave approved');
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

  result = applyPhraseReplacements(result, [
    [/\bI want my holiday approved\b/i, 'I would like to request approval for my holiday'],
    [/\bI need my holiday approved\b/i, 'I would like to request approval for my holiday'],
    [/\bI want my leave approved\b/i, 'I would like to request approval for my leave'],
    [/\bI need my leave approved\b/i, 'I would like to request approval for my leave']
  ]);

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

  result = applyPhraseReplacements(result, [
    [/\bI want my holiday approved\b/i, "I'd like my holiday approved"],
    [/\bI need my holiday approved\b/i, "I'd like my holiday approved"],
    [/\bI want my leave approved\b/i, "I'd like my leave approved"],
    [/\bI need my leave approved\b/i, "I'd like my leave approved"]
  ]);

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

function paraphraseText(text, mode = 'standard') {
  const source = text || '';
  if (!source.trim()) return '';

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

function summarizePage(content) {
  const rawLines = String(content || '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 35);

  const uniqueLines = [];
  const seen = new Set();
  rawLines.forEach((line) => {
    const normalized = line.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueLines.push(line);
    }
  });

  const text = normalizeWhitespace(uniqueLines.join(' '));
  if (!text) return '• No readable page content was found.';

  const sentences = splitSentences(text)
    .map((sentence) => cleanupSpacing(sentence))
    .filter((sentence) => sentence.split(' ').length >= 8 && sentence.length <= 240);

  if (sentences.length === 0) return `• ${text.slice(0, 180)}`;

  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'if', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'by', 'as', 'at', 'it', 'this', 'that', 'from', 'their', 'there', 'about', 'into', 'over', 'after', 'before']);
  const freq = new Map();

  sentences.forEach((sentence) => {
    sentence.toLowerCase().match(/\b[a-z]{4,}\b/g)?.forEach((word) => {
      if (!stopWords.has(word)) freq.set(word, (freq.get(word) || 0) + 1);
    });
  });

  const ranked = sentences
    .map((sentence, index) => {
      const baseScore = (sentence.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).reduce((sum, word) => sum + (freq.get(word) || 0), 0);
      const earlyBonus = index < 3 ? 8 - index * 2 : 0;
      const penalty = sentence.length > 190 ? 5 : 0;
      return { sentence, score: baseScore + earlyBonus - penalty, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index);

  const summaryParts = [];
  const seenSummaries = new Set();

  ranked.forEach((item) => {
    const compressed = compressSummarySentence(item.sentence);
    const key = compressed.toLowerCase();
    if (!compressed || seenSummaries.has(key)) return;
    seenSummaries.add(key);
    summaryParts.push(compressed);
  });

  if (summaryParts.length === 0) {
    return truncateSummarySentence(text, 160);
  }

  const intro = summaryParts[0];
  const bullets = summaryParts.slice(1, 3).map((item) => `• ${item}`);
  return [intro, ...bullets].join('\n');
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

function getWritingScore(text) {
  const source = text || '';
  const words = source.match(/\b[\w']+\b/g) || [];
  const sentences = splitSentences(source);
  const grammarIssues = checkGrammar(source).length;
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

function parseNaturalLanguageTask(text) {
  const source = normalizeWhitespace(text || '');
  const lower = source.toLowerCase();
  const labels = parseLabels(source);
  const priority = parsePriority(lower);

  let title = source
    .replace(/#([a-z0-9_-]+)/gi, '')
    .replace(/\b(today|tomorrow|tonight|daily|weekly|monthly|every day|every week|every month|urgent|important|asap|p1|p2|p3|p4)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) title = source;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return {
    title,
    description: null,
    priority,
    labels,
    recurring: null
  };
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

function getNextRecurringReminder(task, fromDate = new Date()) {
  if (!task.recurring) return null;

  if (task.recurring.pattern === 'interval') {
    return addMinutes(fromDate, task.recurring.intervalMinutes || task.durationMinutes || 30);
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

async function updateActionBadge(tasksInput = null) {
  const tasks = tasksInput || await getTasksFromStorage();
  const attentionCount = tasks.filter((task) => !task.completed && task.attentionNeeded).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: attentionCount > 0 ? String(Math.min(attentionCount, 99)) : '' });
  await chrome.action.setTitle({
    title: attentionCount > 0
      ? `WriteTask Pro (${attentionCount} reminder${attentionCount === 1 ? '' : 's'} ready)`
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
          return applyStandardRewrite(request.text);
        case 'ai:init':
          return await initAiModel();
        case 'ai:run':
          return await runAiInference({
            text: request.text,
            mode: request.mode || null,
            task: request.task || 'rewrite'
          });
        case 'paraphrase':
          return paraphraseText(request.text, request.mode);
        case 'analyzeHumanizeText':
          return analyzeAndHumanizeText(request.text);
        case 'summarize':
          return buildBriefSummary(request.content);
        case 'writingScore':
          return getWritingScore(request.text);
        case 'parseTask':
          return parseNaturalLanguageTask(request.text);
        case 'createTask': {
          const tasks = await getTasksFromStorage();
          const schedule = buildTaskSchedule(request.task, new Date());
          const task = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            title: request.task.title,
            description: request.task.description || '',
            reminderAt: schedule.reminderAt,
            durationMinutes: schedule.durationMinutes,
            kind: request.task.kind || 'task',
            timeSlot: schedule.timeSlot,
            priority: request.task.priority || 'P4',
            labels: request.task.labels || [],
            project: request.task.project || 'Inbox',
            subtasks: request.task.subtasks || [],
            recurring: schedule.recurring,
            recurrenceMode: request.task.recurrenceMode || 'once',
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
