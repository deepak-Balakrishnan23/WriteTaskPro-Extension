/* =========================================================
   WriteTask Pro — Background Service Worker

   Local-first rewrite:
   - No API calls
   - No API keys
   - All writing/task logic runs in-browser
   ========================================================= */

import { sentenceTexts, mapBlocks } from './lib/segment.js';
import { buildBriefSummary } from './lib/summarize.js';
import { lintText, engineReady } from './lib/engine-client.js';
import {
  normalizeWhitespace,
  titleCase,
  escapeRegExp,
  cleanupSpacing,
  sentenceCaseText,
  ensureTrailingPunctuation
} from './lib/text.js';

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

/* Sentence splitting lives in lib/segment.js, and the string helpers in
   lib/text.js. The regex splitter that used to be here treated every
   period as a terminator, so decimals, honorifics, initialisms and
   version strings all shattered — which is how a summary came to report
   2 billion instead of 4.2 billion. */
function splitSentences(text) {
  return sentenceTexts(text);
}

function replaceWholeWord(text, original, suggestion) {
  const regex = new RegExp(`\\b${escapeRegExp(original)}\\b`, 'gi');
  return text.replace(regex, (match) => {
    if (match.toUpperCase() === match) return suggestion.toUpperCase();
    if (match[0] === match[0].toUpperCase()) return titleCase(suggestion);
    return suggestion;
  });
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

/* findVerbProblem is gone with checkGrammar; it hard-coded four patterns
   about wanting leave or a holiday. COMMON_REPLACEMENTS below survives only
   because the paraphrase rewriter still leans on it, and dies with that. */

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

/* checkGrammar is gone. It was a 13-entry typo table matched with \bword\b,
   so it could not see a single inflected form — "recieved", "seperated" and
   "occuring" all passed clean even though their stems were in the table.
   Grammar and spelling now come from Harper (see lib/engine-client.js),
   which returns real spans and replacement lists. */

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

const REWRITE_MODES = {
  formal: applyFormalRewrite,
  casual: applyCasualRewrite,
  shorten: applyShortenRewrite,
  expand: applyExpandRewrite,
  creative: applyCreativeRewrite,
  standard: applyStandardRewrite
};

/* Every rewrite runs per paragraph and the blank lines are restored
   afterwards. Previously the pipeline began with normalizeWhitespace,
   so a multi-paragraph draft came back as a single block — and the
   checker then reported a "Multiple spaces" issue on the text it had
   just flattened. */
function paraphraseText(text, mode = 'standard') {
  const source = text || '';
  if (!source.trim()) return '';

  const transform = REWRITE_MODES[mode] || REWRITE_MODES.standard;
  return mapBlocks(source, transform);
}


/* The "humanize" block is gone: SIMPLE_WORD_MAP, humanizeConnectors,
   depassivizeSentence, splitLongSentence, humanizeSentence, the bigram
   repetition detector, and analyzeAndHumanizeText. None of it was reachable
   from the UI, and depassivizeSentence actively produced word salad —
   "The contract was signed by both parties before the deadline." came back
   as "Both signed the contract parties before the deadline." Rewriting
   voice needs a parser; a regex cannot do it safely. */

/* The extractive summarizer now lives in lib/summarize.js. The version
   that was here truncated sentences mid-way, which can invert a claim,
   and its sentence scorer awarded bonus points for sports vocabulary. */

/* getWritingScore is gone. It graded text by counting how many issues the
   checker found, so the weaker the checker, the higher the grade — badly
   broken sentences scored 100/100 for grammar. A score is only honest once
   there is an engine behind it that can justify the number. */

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
  /* chrome.runtime.sendMessage reaches every extension context, so messages
     addressed to the offscreen engine host arrive here too. Ignore them, or
     this listener answers first and the real host never gets a look in. */
  if (request?.target === 'offscreen') return false;

  const handler = async () => {
    try {
      switch (request.action) {
        case 'checkGrammar':
          return await lintText(request.text);
        case 'engineStatus':
          return { ready: await engineReady() };
        case 'fixGrammar':
          return mapBlocks(request.text || '', applyStandardRewrite);
        case 'paraphrase':
          return paraphraseText(request.text, request.mode);
        case 'summarize':
          return buildBriefSummary(request.content);
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

updateActionBadge().catch(() => {});
