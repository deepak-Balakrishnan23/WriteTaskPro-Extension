let aiWorker = null;
let aiRequestCounter = 0;
const aiPendingRequests = new Map();

const AI_RUNTIME_CONFIG = {
  modelId: 'flan-t5-small',
  modelsBaseUrl: chrome.runtime.getURL('models/'),
  wasmBaseUrl: chrome.runtime.getURL('vendor/'),
  runtimeUrl: chrome.runtime.getURL('vendor/transformers.web.js')
};

function ensureAiWorker() {
  if (aiWorker) return aiWorker;

  aiWorker = new Worker(chrome.runtime.getURL('ai-worker.js'), { type: 'module' });
  aiWorker.onmessage = (event) => {
    const { id, ok, data, error } = event.data || {};
    const pending = aiPendingRequests.get(id);
    if (!pending) return;

    aiPendingRequests.delete(id);
    if (ok) pending.resolve(data);
    else pending.reject(error);
  };

  aiWorker.onerror = (event) => {
    const error = {
      code: 'WORKER_RUNTIME_ERROR',
      message: event.message || event.error?.message || 'Unknown AI worker error',
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
      stack: event.error?.stack || null
    };
    aiPendingRequests.forEach(({ reject }) => reject(error));
    aiPendingRequests.clear();
    aiWorker = null;
  };

  return aiWorker;
}

function postToAiWorker(type, payload) {
  const worker = ensureAiWorker();
  return new Promise((resolve, reject) => {
    const id = `offscreen_ai_${Date.now()}_${++aiRequestCounter}`;
    aiPendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

async function handleRequest(message) {
  switch (message.action) {
    case 'ai:init':
      return await postToAiWorker('init', AI_RUNTIME_CONFIG);
    case 'ai:run':
      await postToAiWorker('init', AI_RUNTIME_CONFIG);
      return await postToAiWorker('run', {
        text: message.text,
        mode: message.mode || null,
        task: message.task || 'rewrite'
      });
    default:
      throw {
        code: 'UNKNOWN_ACTION',
        message: `Unsupported offscreen action: ${message.action}`
      };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-offscreen') return;

  port.onMessage.addListener(async (message) => {
    try {
      const result = await handleRequest(message);
      port.postMessage({
        requestId: message.requestId,
        ok: true,
        data: result
      });
    } catch (error) {
      port.postMessage({
        requestId: message.requestId,
        ok: false,
        error: {
          code: error.code || 'OFFSCREEN_REQUEST_FAILED',
          message: error.message || 'Unknown offscreen error'
        }
      });
    }
  });
});
