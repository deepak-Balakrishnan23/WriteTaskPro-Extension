/* =========================================================
   WriteTask Pro — ONNX AI Worker
   Real local ONNX-backed text generation via Transformers.js.
   ========================================================= */

import { env, pipeline } from './vendor/transformers.js';

let generator = null;
let initPromise = null;
let runtimeConfig = null;

function normalizeSpacing(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sentenceCase(text) {
  return String(text || '')
    .replace(/(^|[.!?]\s+|\n+)([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/\bi\b/g, 'I')
    .trim();
}

function ensureTrailingPunctuation(text) {
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function replaceWholeWord(text, original, replacement) {
  return String(text || '').replace(new RegExp(`\\b${original}\\b`, 'gi'), (match) => {
    if (match.toUpperCase() === match) return replacement.toUpperCase();
    if (match[0] === match[0].toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
  });
}

function splitSentences(text) {
  return String(text || '')
    .match(/[^.!?]+[.!?]?/g)
    ?.map((item) => item.trim())
    .filter(Boolean) || [];
}

function splitLongSentence(sentence, maxChars) {
  if (sentence.length <= maxChars) return [sentence];

  const words = sentence.split(/\s+/);
  const parts = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) parts.push(current);
      current = word;
    }
  });

  if (current) parts.push(current);
  return parts;
}

function chunkByParagraphs(text, maxChars) {
  const paragraphs = String(text || '')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!paragraphs.length) return [];

  const chunks = [];
  let current = '';

  paragraphs.forEach((paragraph) => {
    if (paragraph.length > maxChars) {
      const sentences = splitSentences(paragraph);
      if (!sentences.length) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        chunks.push(paragraph);
        return;
      }

      sentences.forEach((sentence) => {
        const parts = splitLongSentence(sentence, maxChars);
        parts.forEach((part) => {
          const candidate = current ? `${current} ${part}` : part;
          if (candidate.length <= maxChars) {
            current = candidate;
          } else {
            if (current) chunks.push(current);
            current = part;
          }
        });
      });
      return;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = paragraph;
    }
  });

  if (current) chunks.push(current);
  return chunks;
}

function prepareSummarySource(text) {
  const seen = new Set();
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => line.length >= 20)
    .filter((line) => !/^(share|copy link|advertisement|sponsored|sign in|log in|subscribe)$/i.test(line))
    .filter((line) => {
      const normalized = line.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

  return lines.join('\n\n');
}

function splitIntoChunks(text, task, mode) {
  const normalized = task === 'summarize' ? prepareSummarySource(text) : String(text || '').trim();
  if (!normalized) return [];

  if (task === 'summarize') {
    return chunkByParagraphs(normalized, 1200);
  }

  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  const maxChars = task === 'grammar' ? 140 : 180;
  const groupLimit = mode === 'shorten' ? 2 : 1;

  paragraphs.forEach((paragraph) => {
    const sentences = splitSentences(paragraph);
    if (!sentences.length) {
      chunks.push(paragraph);
      return;
    }

    if (task === 'grammar') {
      sentences.forEach((sentence) => {
        splitLongSentence(sentence, maxChars).forEach((part) => chunks.push(part));
      });
      return;
    }

    let current = '';
    let currentCount = 0;
    sentences.forEach((sentence) => {
      const safeParts = splitLongSentence(sentence, maxChars);
      safeParts.forEach((part) => {
        const candidate = current ? `${current} ${part}` : part;
        if (candidate.length <= maxChars && currentCount < groupLimit) {
          current = candidate;
          currentCount += 1;
        } else {
          if (current) chunks.push(current);
          current = part;
          currentCount = 1;
        }
      });
    });

    if (current) chunks.push(current);
  });

  return chunks;
}

function buildPrompt(task, text, mode, strict = false) {
  const cleaned = normalizeSpacing(text);
  if (!cleaned) return '';

  if (task === 'grammar') {
    if (strict) {
      return `Correct grammar and spelling sentence by sentence. Do not summarize. Keep every name, fact, and detail. Return only the corrected text.\nText: ${cleaned}`;
    }
    return `Fix grammar and spelling. Keep the same meaning and keep all details. Return only the corrected text.\nText: ${cleaned}`;
  }

  if (task === 'summarize') {
    if (strict) {
      return `Summarize this content into a concise factual summary. Cover the main points only, do not rewrite line by line, do not copy long passages, and do not invent details. Return only the summary.\nText: ${cleaned}`;
    }
    return `Write a short summary of this content. Focus on the most important points, keep names and key facts, and omit minor detail. Return only the summary.\nText: ${cleaned}`;
  }

  const modePrompts = {
    standard: 'Rewrite this text clearly and naturally. Keep all important details. Return only the rewritten text.',
    formal: 'Rewrite this text in a formal and professional tone. Keep all important details. Return only the rewritten text.',
    casual: 'Rewrite this text in a casual and friendly tone. Keep all important details. Return only the rewritten text.',
    shorten: 'Rewrite this text to be shorter and easier to read. Keep the key meaning. Return only the rewritten text.',
    expand: 'Rewrite this text with a little more detail and clarity. Keep the original meaning. Return only the rewritten text.',
    creative: 'Rewrite this text in a more vivid and creative style. Keep the original meaning. Return only the rewritten text.'
  };

  if (strict) {
    return `Rewrite the text sentence by sentence. Keep every fact, name, and detail. Do not summarize or drop information. Return only the rewritten text.\nText: ${cleaned}`;
  }

  return `${modePrompts[mode] || modePrompts.standard}\nText: ${cleaned}`;
}

function cleanGeneratedText(text, fallback) {
  const cleaned = normalizeSpacing(
    String(text || '')
      .replace(/^(answer|output|rewritten text|corrected text)\s*:\s*/i, '')
      .replace(/^text\s*:\s*/i, '')
  );
  return cleaned || fallback;
}

function countWords(text) {
  return normalizeSpacing(text).split(/\s+/).filter(Boolean).length;
}

function getImportantWords(text) {
  return new Set(
    normalizeSpacing(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4)
  );
}

function hasRunawayRepetition(text) {
  const words = normalizeSpacing(text).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;

  let streak = 1;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] === words[i - 1]) {
      streak += 1;
      if (streak >= 3) return true;
    } else {
      streak = 1;
    }
  }

  const counts = new Map();
  words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  return [...counts.values()].some((count) => count >= 6);
}

function expectedMinRatio(task, mode) {
  if (task === 'grammar') return 0.65;
  if (task === 'summarize') return 0.18;
  if (mode === 'shorten') return 0.35;
  return 0.55;
}

function isSuspiciousOutput(input, output, task, mode) {
  const inputWords = countWords(input);
  const outputWords = countWords(output);
  if (!outputWords) return true;
  if (inputWords < 6) return false;

  const minRatio = expectedMinRatio(task, mode);
  if (outputWords / inputWords < minRatio) return true;

  const inputSentences = splitSentences(input).length;
  const outputSentences = splitSentences(output).length;
  if (inputSentences > 1 && outputSentences === 1 && task !== 'grammar' && task !== 'summarize') {
    return true;
  }

  if (hasRunawayRepetition(output)) {
    return true;
  }

  const inputTerms = getImportantWords(input);
  if (inputTerms.size > 0) {
    const outputTerms = getImportantWords(output);
    const preserved = [...inputTerms].filter((word) => outputTerms.has(word)).length;
    const ratio = preserved / inputTerms.size;
    if (task === 'grammar' && ratio < 0.55) return true;
    if (task === 'summarize' && ratio < 0.15) return true;
    if (task !== 'grammar' && mode !== 'shorten' && ratio < 0.4) return true;
  }

  return false;
}

function applyModeStyling(text, mode) {
  let result = sentenceCase(normalizeSpacing(text));

  switch (mode) {
    case 'formal':
      [
        ["can't", 'cannot'],
        ["don't", 'do not'],
        ["won't", 'will not'],
        ["I'm", 'I am'],
        ["it's", 'it is'],
        ["you're", 'you are'],
        ["we're", 'we are'],
        ["thanks", 'thank you'],
        ["help", 'assist'],
        ["buy", 'purchase'],
        ["get", 'obtain']
      ].forEach(([from, to]) => {
        result = replaceWholeWord(result, from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), to);
      });
      result = result
        .replace(/\bI need\b/gi, 'I would like')
        .replace(/\bI want\b/gi, 'I would like')
        .replace(/\bPlease\b/g, 'Kindly');
      return ensureTrailingPunctuation(result);
    case 'casual':
      [
        ['cannot', "can't"],
        ['do not', "don't"],
        ['will not', "won't"],
        ['I am', "I'm"],
        ['it is', "it's"],
        ['you are', "you're"],
        ['we are', "we're"],
        ['thank you', 'thanks']
      ].forEach(([from, to]) => {
        result = replaceWholeWord(result, from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), to);
      });
      result = result
        .replace(/\bI would like\b/gi, "I'd like")
        .replace(/\bKindly\b/gi, 'Please')
        .replace(/\bPlease let me know\b/gi, 'Let me know');
      return ensureTrailingPunctuation(result);
    case 'standard':
    default:
      return ensureTrailingPunctuation(result);
  }
}

async function generateWithPrompt(prompt, wordCount, fallback) {
  const maxNewTokens = Math.min(256, Math.max(96, Math.ceil(wordCount * 2.2)));
  const outputs = await generator(prompt, {
    max_new_tokens: maxNewTokens,
    temperature: 0.1,
    do_sample: false
  });
  const first = Array.isArray(outputs) ? outputs[0] : outputs;
  const rawText = first?.generated_text?.trim?.() || '';
  return cleanGeneratedText(rawText, fallback);
}

async function generateChunk(task, mode, chunk) {
  const wordCount = countWords(chunk);
  const firstPass = await generateWithPrompt(buildPrompt(task, chunk, mode, false), wordCount, chunk);
  if (!isSuspiciousOutput(chunk, firstPass, task, mode)) {
    return firstPass;
  }

  const secondPass = await generateWithPrompt(buildPrompt(task, chunk, mode, true), wordCount, chunk);
  if (!isSuspiciousOutput(chunk, secondPass, task, mode)) {
    return secondPass;
  }

  return chunk;
}

async function summarizeChunks(chunks) {
  const partials = [];

  for (const chunk of chunks) {
    partials.push(await generateChunk('summarize', null, chunk));
  }

  const combined = partials
    .map((part) => normalizeSpacing(part))
    .filter(Boolean)
    .join(' ');

  if (partials.length <= 1) {
    return combined;
  }

  const combinedChunks = chunkByParagraphs(combined, 900);
  if (combinedChunks.length <= 1) {
    return await generateChunk('summarize', null, combined);
  }

  const reduced = [];
  for (const chunk of combinedChunks) {
    reduced.push(await generateChunk('summarize', null, chunk));
  }

  return normalizeSpacing(reduced.join(' '));
}

async function initModel(config) {
  if (generator) return { ready: true, model: config.modelId };
  if (initPromise) return initPromise;

  runtimeConfig = config;

  initPromise = (async () => {
    try {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = config.modelsBaseUrl;
      env.useBrowserCache = false;
      env.useFSCache = false;
      env.useCustomCache = false;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = config.wasmBaseUrl;
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }

      generator = await pipeline('text2text-generation', config.modelId, {
        local_files_only: true,
        quantized: true,
        dtype: 'q8'
      });

      return { ready: true, model: config.modelId };
    } catch (error) {
      generator = null;
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

async function runInference(payload) {
  if (!generator) {
    throw new Error('Model is not initialized');
  }

  const effectiveMode = payload.task === 'rewrite' ? 'standard' : payload.mode;
  const chunks = splitIntoChunks(payload.text, payload.task, effectiveMode);
  if (chunks.length === 0) {
    return { text: '' };
  }

  if (payload.task === 'summarize') {
    const text = await summarizeChunks(chunks);
    return {
      text,
      meta: {
        model: runtimeConfig?.modelId || null,
        task: payload.task || null,
        mode: payload.mode || null
      }
    };
  }

  const parts = [];
  for (const chunk of chunks) {
    parts.push(await generateChunk(payload.task, effectiveMode, chunk));
  }

  let text = parts.join(' ').replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (payload.task === 'rewrite') {
    text = applyModeStyling(text, payload.mode || 'standard');
  }

  return {
    text,
    meta: {
      model: runtimeConfig?.modelId || null,
      task: payload.task || null,
      mode: payload.mode || null
    }
  };
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};

  try {
    if (type === 'init') {
      const result = await initModel(payload);
      self.postMessage({ id, ok: true, data: result });
      return;
    }

    if (type === 'run') {
      const result = await runInference(payload);
      self.postMessage({ id, ok: true, data: result });
      return;
    }

    self.postMessage({
      id,
      ok: false,
      error: {
        code: 'UNKNOWN_MESSAGE_TYPE',
        message: `Unsupported worker message type: ${type}`
      }
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        code: type === 'init' ? 'MODEL_INIT_FAILED' : 'INFERENCE_FAILED',
        message: error.message || 'Unknown worker error',
        stack: error.stack || null
      }
    });
  }
};
