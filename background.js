/* =========================================================
   Tasve — Background Service Worker

   Local-first, and local-only:
   - No API calls
   - No API keys
   - No model download
   - All writing/task logic runs in-browser
   ========================================================= */

import { buildBriefSummary } from './lib/summarize.js';
import { lintText, engineReady } from './lib/engine-client.js';
import { readNotificationSettings } from './lib/notification-settings.js';
import { normalizeWhitespace } from './lib/text.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'writetask-grammar', title: 'Tasve: Check Grammar', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-add-task', title: 'Tasve: Add as Task', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'writetask-summarize', title: 'Tasve: Summarize Page', contexts: ['page'] });
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

  if (info.menuItemId === 'writetask-grammar') send({ action: 'contextMenuGrammar', text: info.selectionText });
  else if (info.menuItemId === 'writetask-add-task') send({ action: 'contextMenuAddTask', text: info.selectionText, url: info.pageUrl });
  else if (info.menuItemId === 'writetask-summarize') send({ action: 'contextMenuSummarize' });
});

/* =========================================================
   No generative rewriting

   Rewrite/Formal/Casual/Professional/Friendly/Expand/Shorten and the
   AI summarizer are gone, along with the Gemini Nano plumbing behind
   them. Chrome's built-in AI is the only local option and it needs a
   2-4GB on-device model with no smaller tier, so on any machine that
   has not downloaded it every one of those buttons was dead. A regex
   cannot stand in for them — the deleted version proved that by
   turning "The contract was signed by both parties" into "Both signed
   the contract parties".

   What is left is what works offline with no model: Harper for
   grammar (see lib/engine-client.js) and the extractive summarizer in
   lib/summarize.js, which selects real sentences rather than
   generating new ones.
   ========================================================= */

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
    focus: 'Tasve — Focus time',
    water: 'Tasve — Water break',
    screen: 'Tasve — Screen break',
    tea: 'Tasve — Tea break',
    lunch: 'Tasve — Lunch break',
    task: 'Tasve — Reminder'
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
    message: getReminderMessage(task),
    /* The user's own wording, kept separate from the notification title so
       the overlay can show it as the message without inheriting the
       "Tasve — " prefix. */
    taskTitle: typeof task.title === 'string' ? task.title : '',
    recurring: Boolean(task.recurring)
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
      ? `Tasve (${attentionCount} reminder${attentionCount === 1 ? '' : 's'} ready${readyTasks[0]?.title ? `: ${readyTasks[0].title}` : ''})`
      : 'Tasve'
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
        await routeReminder(reminderPayload);
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
    console.error('Tasve alarm error:', err);
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

/* =========================================================
   Reminder routing

   The overlay renders in a page, so it needs a page to render in. The
   active tab is the first choice — instant, no window flash. When there
   isn't one we can inject into (a chrome:// page, the Web Store, no open
   window at all) a maximized popup window running reminder.html takes
   over, so a reminder is never silently dropped just because of what the
   user happened to be looking at.
   ========================================================= */

const INJECTABLE = /^https?:\/\//i;

async function getActiveInjectableTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id && INJECTABLE.test(tab.url || '')) return tab;
  } catch {
    /* No focused window, or the query raced a closing one. */
  }
  return null;
}

async function openReminderWindow(task) {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`reminder.html?id=${encodeURIComponent(task.id)}`),
      type: 'popup',
      focused: true,
      state: 'maximized'
    });
    return true;
  } catch (err) {
    /* The reminder still lives in attentionNeeded and on the badge, so
       this degrades to the pre-overlay behaviour rather than vanishing. */
    console.debug('Tasve: could not open the reminder window', err);
    return false;
  }
}

async function routeReminder(task) {
  const settings = await readNotificationSettings(chrome.storage.local);
  if (!settings.fullscreenReminders) return;

  const tab = await getActiveInjectableTab();
  if (tab) {
    try {
      /* Addressed to one tab, not broadcast: twenty open tabs must not
         produce twenty overlays. */
      await chrome.tabs.sendMessage(tab.id, { action: 'showReminderOverlay', task });
      return;
    } catch {
      /* No content script yet (installed but never reloaded), or the tab
         closed mid-flight. The window path covers both. */
    }
  }

  await openReminderWindow(task);
}

/* Done in the overlay. A recurring ritual must not be marked complete —
   that would kill every future water break — so it only clears the
   attention flag and lets the already-scheduled next alarm stand. */
async function resolveReminder(taskId) {
  const tasks = await getTasksFromStorage();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;

  if (task.recurring) {
    await clearReminderAttention(taskId);
    broadcastMessage({ action: 'tasksUpdated' });
    return;
  }

  await completeTask(taskId);
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
        case 'resolveReminder':
          await resolveReminder(request.taskId);
          return true;
        case 'getReminderTask': {
          const tasks = await getTasksFromStorage();
          const task = tasks.find((item) => item.id === request.taskId);
          return task ? buildReminderPayload(task) : null;
        }
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
