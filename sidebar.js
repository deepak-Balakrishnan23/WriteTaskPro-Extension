/* =========================================================
   WriteTask Pro — Sidebar JS
   ========================================================= */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── DOM Refs ──
  const btnSettings = $('#btn-settings'), btnClose = $('#btn-close');
  const tabs = $$('.tab');
  const panels = { write: $('#panel-write'), tasks: $('#panel-tasks'), settings: $('#panel-settings') };
  const writeInput = $('#write-input'), modeBtns = $$('.mode-btn');
  const btnParaphrase = $('#btn-paraphrase'), btnGrammar = $('#btn-grammar'), btnSummarize = $('#btn-summarize');
  const writeResult = $('#write-result'), resultContent = $('#result-content'), resultSubtitle = $('#result-subtitle'), writeLoading = $('#write-loading');
  const btnCopyResult = $('#btn-copy-result');
  const taskInput = $('#task-input'), btnAddTask = $('#btn-add-task'), taskLoading = $('#task-loading');
  const priorityBtns = $$('.priority-btn');
  const ritualBtns = $$('.ritual-btn');
  const durationBtns = $$('.duration-btn');
  const recurrenceBtns = $$('.recurrence-btn');
  const timeRow = $('#time-row');
  const timeBadges = $('#time-badges');
  const taskList = $('#task-list');
  const btnCloseSettings = $('#btn-close-settings'), settingTheme = $('#setting-theme');
  const btnSaveSettings = $('#btn-save-settings');

  // ── State ──
  let selectedMode = 'standard';
  let selectedPriority = 'P2';
  let selectedTaskKind = 'task';
  let selectedDuration = 15;
  let selectedRecurrence = 'once';
  let selectedTimeSlot = '';
  let editingTaskId = null;
  let lastResultText = '';
  let allTasks = [];
  let previousTab = 'write';           // BUG-01 FIX
  let summarizeTimeoutId = null;        // BUG-02 FIX
  let focusedTaskId = null;
  let focusHighlightTimer = null;

  // ── Theme ──
  function applyTheme(theme) {
    if (theme === 'system') {
      document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  // ── Init ──
  async function init() {
    await loadSettings();
    await loadTasks();
    initTaskListDelegation();     // BUG-06 FIX
    window.addEventListener('message', handleContentMessage);

    // BUG-07 FIX: Signal to content script that sidebar is ready
    window.parent.postMessage({ source: 'wtp-sidebar', action: 'sidebarReady' }, '*');
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(['wtp_settings']);
      const s = result.wtp_settings || {};
      if (s.theme) settingTheme.value = s.theme;
      applyTheme(s.theme || 'system');
    } catch { }
  }

  // ══════════════════════════════════════
  // BUG-01 FIX: Tab navigation with previousTab tracking
  // ══════════════════════════════════════
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const panelName = tab.dataset.tab;
      Object.values(panels).forEach(p => p.classList.remove('active'));
      if (panels[panelName]) panels[panelName].classList.add('active');
    });
  });

  btnSettings.addEventListener('click', () => {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) previousTab = activeTab.dataset.tab;
    Object.values(panels).forEach(p => p.classList.remove('active'));
    panels.settings.classList.add('active');
    document.body.classList.add('settings-open');
  });

  btnCloseSettings.addEventListener('click', () => {
    closeSettingsPanel();
  });

  function closeSettingsPanel() {
    panels.settings.classList.remove('active');
    document.body.classList.remove('settings-open');
    tabs.forEach(t => t.classList.remove('active'));
    const target = previousTab || 'write';
    const tabBtn = document.querySelector(`.tab[data-tab="${target}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    if (panels[target]) panels[target].classList.add('active');
  }

  btnSaveSettings.addEventListener('click', async () => {
    const settings = {
      theme: settingTheme.value
    };
    await chrome.storage.local.set({ wtp_settings: settings });
    applyTheme(settings.theme);
    showToast('Settings saved');
  });

  btnClose.addEventListener('click', () => {
    window.parent.postMessage({ source: 'wtp-sidebar', action: 'closeSidebar' }, '*');
  });

  // ── Paraphrase Mode ──
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMode = btn.dataset.mode;
    });
  });

  priorityBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      priorityBtns.forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      selectedPriority = btn.dataset.priority;
    });
  });

  const taskTemplates = {
    task: { text: '', priority: 'P2', minutes: 15 },
    focus: { text: 'Focused work sprint', priority: 'P2', minutes: 45 },
    water: { text: 'Drink water and reset', priority: 'P4', minutes: 30 },
    screen: { text: 'Screen break and eye reset', priority: 'P4', minutes: 30 },
    tea: { text: 'Tea break', priority: 'P3', minutes: 60, timeSlot: '09:00' },
    lunch: { text: 'Lunch break', priority: 'P3', minutes: 15, timeSlot: '12:00' }
  };

  const taskTimeOptions = {
    tea: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'],
    lunch: ['12:00', '12:30', '13:00', '13:30', '14:00']
  };

  ritualBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const previousKind = selectedTaskKind;
      ritualBtns.forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      selectedTaskKind = btn.dataset.kind;
      applyTaskTemplate(selectedTaskKind, previousKind);
    });
  });

  durationBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      durationBtns.forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      selectedDuration = Number(btn.dataset.minutes || 15);
    });
  });

  recurrenceBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      recurrenceBtns.forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      selectedRecurrence = btn.dataset.mode || 'once';
      syncTaskComposer();
    });
  });

  if (timeBadges) {
    timeBadges.addEventListener('click', (event) => {
      const btn = event.target.closest('.time-btn');
      if (!btn) return;
      setTimeSlot(btn.dataset.time || '');
    });
  }

  // ── Send to Background ──
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (response?.error) reject(new Error(response.error));
          else resolve(response);
        });
      } catch (err) { reject(err); }
    });
  }

  function showLoading(el) { el.style.display = 'flex'; }
  function hideLoading(el) { el.style.display = 'none'; }
  function showResult(title, html) {
    resultSubtitle.textContent = title;
    resultContent.innerHTML = html;
    writeResult.style.display = 'block';
  }
  function hideResult() { writeResult.style.display = 'none'; }
  function getWriteText() { return writeInput.value.trim(); }

  async function runSummary(content) {
    const text = String(content || '').trim();
    if (!text) {
      showToast('Enter or select some text first');
      return;
    }

    try {
      const summary = await sendMessage({ action: 'summarize', content: text });
      lastResultText = summary;
      showResult('Summary', `<div style="white-space:pre-wrap;">${escapeHTML(summary)}</div>`);
    } catch (err) {
      showResult('Error', `<div style="color:var(--danger);">${escapeHTML(err.message)}</div>`);
    }
  }

  function legacyCopyText(text) {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.setAttribute('readonly', 'readonly');
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    temp.style.pointerEvents = 'none';
    temp.style.top = '-9999px';
    document.body.appendChild(temp);
    temp.focus();
    temp.select();
    temp.setSelectionRange(0, temp.value.length);

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }

    temp.remove();
    return copied;
  }

  // ── Paraphrase ──
  btnParaphrase.addEventListener('click', async () => {
    const text = getWriteText();
    if (!text) return showToast('Enter some text first');
    hideResult(); showLoading(writeLoading);
    try {
      const outputText = await sendMessage({ action: 'paraphrase', text, mode: selectedMode });
      lastResultText = outputText;
      showResult('Improved text', `<div style="white-space:pre-wrap;">${escapeHTML(outputText)}</div>`);
    } catch (err) { showResult('Error', `<div style="color:var(--danger);">${escapeHTML(err.message)}</div>`); }
    hideLoading(writeLoading);
  });

  // ── Grammar ──
  const SEVERITY_LABELS = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style' };

  /* Renders the issue list from the engine. Nothing is applied automatically:
     the user picks a replacement, one issue at a time. The previous version
     showed a single rewritten blob with no explanation of what changed, which
     is how it managed to hand back "I want my holiday approved approval." */
  function renderIssues(text, issues) {
    if (!issues.length) {
      showResult('Grammar check', '<div class="issue-clean">No issues found.</div>');
      return;
    }

    const rows = issues.map((issue, index) => {
      const context = text.slice(
        Math.max(0, issue.offset - 32),
        Math.min(text.length, issue.offset + issue.length + 32)
      );
      const buttons = issue.replacements.slice(0, 3).map((replacement, choice) => {
        const label = replacement.kind === 'remove'
          ? `Remove “${escapeHTML(issue.problemText)}”`
          : escapeHTML(replacement.text);
        return `<button class="issue-fix" data-issue="${index}" data-choice="${choice}">${label}</button>`;
      }).join('');

      return `
        <div class="issue" data-issue="${index}">
          <div class="issue-head">
            <span class="issue-sev ${escapeHTML(issue.severity)}">${escapeHTML(SEVERITY_LABELS[issue.severity] || 'Suggestion')}</span>
            <code class="issue-word">${escapeHTML(issue.problemText)}</code>
          </div>
          <div class="issue-msg">${escapeHTML(issue.message)}</div>
          <div class="issue-context">…${escapeHTML(context)}…</div>
          <div class="issue-fixes">${buttons}</div>
        </div>`;
    }).join('');

    const count = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
    showResult(count, rows);
  }

  /* Applying edits the textarea in place, so offsets shift. Re-checking after
     each apply keeps the remaining issues honest rather than letting the user
     accept a suggestion whose position is already wrong. */
  async function applyIssueInInput(issue, choice) {
    const text = writeInput.value;
    const end = issue.offset + issue.length;

    if (text.slice(issue.offset, end) !== issue.problemText) {
      showToast('Text changed — rechecking');
      return runGrammarCheck();
    }

    const replacement = issue.replacements[choice];
    if (!replacement) return;

    const insert = replacement.kind === 'insertAfter'
      ? issue.problemText + replacement.text
      : replacement.kind === 'remove' ? '' : replacement.text;

    writeInput.setRangeText(insert, issue.offset, end, 'end');
    await runGrammarCheck();
  }

  let currentIssues = [];

  async function runGrammarCheck() {
    const text = getWriteText();
    if (!text) return showToast('Enter some text first');

    hideResult();
    showLoading(writeLoading);
    try {
      const issues = await sendMessage({ action: 'checkGrammar', text: writeInput.value });
      currentIssues = Array.isArray(issues) ? issues : [];
      lastResultText = writeInput.value;
      renderIssues(writeInput.value, currentIssues);
    } catch (err) {
      // An engine failure must never look like clean text.
      showResult('Error', `<div style="color:var(--danger);">${escapeHTML(err.message)}</div>`);
    }
    hideLoading(writeLoading);
  }

  btnGrammar.addEventListener('click', runGrammarCheck);

  resultContent.addEventListener('click', (event) => {
    const fix = event.target.closest('.issue-fix');
    if (!fix) return;
    const issue = currentIssues[Number(fix.dataset.issue)];
    if (issue) applyIssueInInput(issue, Number(fix.dataset.choice));
  });

  // ══════════════════════════════════════
  // BUG-02 FIX: Summarize with 8s timeout
  // ══════════════════════════════════════
  btnSummarize.addEventListener('click', async () => {
    const text = getWriteText();
    hideResult(); showLoading(writeLoading);

    if (text) {
      await runSummary(text);
      hideLoading(writeLoading);
      return;
    }

    if (summarizeTimeoutId) clearTimeout(summarizeTimeoutId);
    summarizeTimeoutId = setTimeout(() => {
      hideLoading(writeLoading);
      showResult('Error', '<div style="color:var(--danger);">Could not retrieve page content. Make sure you\'re on a regular webpage (not a browser settings page).</div>');
      summarizeTimeoutId = null;
    }, 8000);
    window.parent.postMessage({ source: 'wtp-sidebar', action: 'getPageContent' }, '*');
  });

  // ── Copy & Replace ──
  btnCopyResult.addEventListener('click', async () => {
    const text = lastResultText || resultContent.innerText;
    if (!text) return;

    if (legacyCopyText(text)) {
      showToast('Copied');
      return;
    }

    showToast('Copy failed');
  });

  // ══════════════════════════════════════════
  // TASKS
  // ══════════════════════════════════════════

  btnAddTask.addEventListener('click', addTaskFromInput);
  taskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTaskFromInput(); });

  async function addTaskFromInput() {
    const text = taskInput.value.trim(); if (!text) return;
    showLoading(taskLoading);
    try {
      const parsed = await sendMessage({ action: 'parseTask', text });
      parsed.title = text;
      parsed.priority = selectedTaskKind === 'task' ? selectedPriority : null;
      parsed.kind = selectedTaskKind;
      parsed.durationMinutes = selectedDuration;
      parsed.recurrenceMode = selectedRecurrence;
      parsed.timeSlot = selectedTimeSlot || null;

      if (editingTaskId) {
        await sendMessage({
          action: 'updateTask',
          taskId: editingTaskId,
          updates: {
            title: parsed.title,
            description: parsed.description || '',
            priority: parsed.priority,
            kind: parsed.kind,
            durationMinutes: parsed.durationMinutes,
            recurrenceMode: parsed.recurrenceMode,
            timeSlot: parsed.timeSlot,
            labels: parsed.labels || []
          }
        });
        await sendMessage({ action: 'acknowledgeReminders', taskId: editingTaskId });
        showToast('Task updated');
      } else {
        await sendMessage({ action: 'createTask', task: parsed });
        showToast(`Reminder set for ${formatDuration(selectedDuration)}`);
      }

      taskInput.value = '';
      resetTaskComposer();
      await loadTasks();
    } catch (err) { showToast(err.message); }
    hideLoading(taskLoading);
  }

  async function loadTasks() {
    try { allTasks = await sendMessage({ action: 'getTasks' }) || []; } catch { allTasks = []; }
    renderTasks();
  }

  function renderTasks() {
    renderListView();
  }

  function getFilteredTasks() {
    return [...allTasks];
  }

  function renderListView() {
    const tasks = getFilteredTasks();
    const pending = tasks.filter(t => !t.completed);
    const completed = tasks.filter(t => t.completed);
    if (tasks.length === 0) { taskList.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><p>No tasks yet. Add one above!</p></div>'; return; }
    const priorityOrder = { P1: 0, P2: 1, P3: 2, P4: 3 };
    pending.sort((a, b) => {
      if (a.attentionNeeded !== b.attentionNeeded) return a.attentionNeeded ? -1 : 1;
      const timeA = a.reminderAt ? new Date(a.reminderAt).getTime() : Number.MAX_SAFE_INTEGER;
      const timeB = b.reminderAt ? new Date(b.reminderAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (timeA !== timeB) return timeA - timeB;
      return (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3);
    });
    let html = pending.map(t => renderTaskItem(t)).join('');
    if (completed.length > 0) {
      html += `<div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-top:12px;padding:4px 0;">COMPLETED (${completed.length})</div>`;
      html += completed.slice(0, 8).map(t => renderTaskItem(t)).join('');
    }
    taskList.innerHTML = html;
  }

  function renderTaskItem(task) {
    const reminderLabel = task.reminderAt ? getReminderLabel(task) : '';
    const kindLabel = getKindLabel(task.kind);
    const priorityTag = task.kind === 'task' && task.priority ? `<span class="task-tag priority ${task.priority}">${task.priority}</span>` : '';
    const recurrenceTag = task.recurrenceMode === 'recurring' ? '<span class="task-tag date">Repeats</span>' : '';
    const scheduleTag = getScheduleTag(task);
    const leading = task.kind === 'task'
      ? `<button class="task-check ${task.completed ? 'checked' : ''}" data-priority="${task.priority || 'P4'}" data-id="${task.id}" title="Complete task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></button>`
      : `<div class="task-kind-icon ${escapeHTML(task.kind || 'task')}">${getTaskIcon(task.kind)}</div>`;
    const actions = task.kind === 'task'
      ? `<div class="task-actions"><button class="task-action-btn" data-action="edit" data-id="${task.id}" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button><button class="task-action-btn" data-action="delete" data-id="${task.id}" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>`
      : '';
    const editingClass = editingTaskId === task.id ? ' editing' : '';
    const readyClass = task.attentionNeeded ? ' ready' : '';
    const focusedClass = focusedTaskId === task.id ? ' focused' : '';
    return `<div class="task-item ${task.completed ? 'completed' : ''}${editingClass}${readyClass}${focusedClass}" data-id="${task.id}">${leading}<div class="task-body"><div class="task-title">${escapeHTML(task.title)}</div><div class="task-meta">${reminderLabel ? `<span class="task-tag date">${escapeHTML(reminderLabel)}</span>` : ''}${scheduleTag ? `<span class="task-tag date">${escapeHTML(scheduleTag)}</span>` : ''}${kindLabel ? `<span class="task-tag kind">${escapeHTML(kindLabel)}</span>` : ''}${priorityTag}${recurrenceTag}${(task.labels || []).map(l => `<span class="task-tag label">${escapeHTML(l)}</span>`).join('')}</div></div>${actions}</div>`;
  }

  function focusTaskInList(taskId) {
    if (!taskId) return;
    focusedTaskId = taskId;
    renderTasks();
    const card = Array.from(document.querySelectorAll('.task-item')).find((item) => item.dataset.id === taskId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('focused');
    if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
    focusHighlightTimer = setTimeout(() => {
      card.classList.remove('focused');
      if (focusedTaskId === taskId) focusedTaskId = null;
    }, 2600);
  }

  // ══════════════════════════════════════
  // BUG-06 FIX: Event delegation for task list (attached ONCE in init)
  // ══════════════════════════════════════
  function initTaskListDelegation() {
    taskList.addEventListener('click', async (e) => {
      const check = e.target.closest('.task-check');
      if (check) {
        const id = check.dataset.id;
        try {
          if (check.classList.contains('checked')) { await sendMessage({ action: 'updateTask', taskId: id, updates: { completed: false, completedAt: null } }); }
          else { await sendMessage({ action: 'completeTask', taskId: id }); }
          await loadTasks();
        } catch (err) { showToast(err.message); }
        return;
      }
      const del = e.target.closest('.task-action-btn[data-action="delete"]');
      if (del) {
        try { await sendMessage({ action: 'deleteTask', taskId: del.dataset.id }); await loadTasks(); }
        catch (err) { showToast(err.message); }
        return;
      }
      const edit = e.target.closest('.task-action-btn[data-action="edit"]');
      if (edit) {
        const task = allTasks.find((item) => item.id === edit.dataset.id);
        if (!task) return;
        startEditingTask(task);
        return;
      }

      const card = e.target.closest('.task-item');
      if (card) {
        const task = allTasks.find((item) => item.id === card.dataset.id);
        if (!task || task.completed) return;
        startEditingTask(task);
      }
    });
  }

  // ── Handle Messages from Content Script ──
  function handleContentMessage(event) {
    // Only the embedding page's content script may drive the sidebar.
    // data.source is attacker-controlled; event.source is not.
    if (event.source !== window.parent) return;

    const data = event.data;
    if (data?.source !== 'wtp-content') return;

    switch (data.action) {
      case 'openPanel':
        switchToPanel(data.panel || 'write');
        if (data.focusTaskId) {
          focusedTaskId = data.focusTaskId;
          if ((data.panel || 'write') === 'tasks') {
            loadTasks().then(() => focusTaskInList(data.focusTaskId)).catch(() => { });
          }
        }
        break;
      case 'paraphrase':
        writeInput.value = data.text;
        switchToPanel('write');
        btnParaphrase.click();
        break;
      case 'grammar':
        writeInput.value = data.text;
        switchToPanel('write');
        btnGrammar.click();
        break;
      case 'tone':
        writeInput.value = data.text;
        switchToPanel('write');
        break;
      case 'addTask':
        taskInput.value = data.text;
        switchToPanel('tasks');
        break;
      case 'summarize':
        writeInput.value = data.content || '';
        writeInput.scrollTop = 0;
        switchToPanel('write');
        (async () => {
          showLoading(writeLoading);
          if (summarizeTimeoutId) { clearTimeout(summarizeTimeoutId); summarizeTimeoutId = null; }
          await runSummary(data.content);
          hideLoading(writeLoading);
        })();
        break;
      case 'pageContent':
        // BUG-02 FIX: Clear the summarize timeout
        if (summarizeTimeoutId) { clearTimeout(summarizeTimeoutId); summarizeTimeoutId = null; }
        writeInput.value = data.content || '';
        writeInput.scrollTop = 0;
        switchToPanel('write');
        (async () => {
          await runSummary(data.content);
          hideLoading(writeLoading);
        })();
        break;
      case 'tasksUpdated':
        loadTasks();
        break;
      case 'reminderTriggered':
        if (data.task?.message) {
          showToast(data.task.message, { variant: 'reminder' });
        }
        loadTasks();
        break;
    }
  }

  function switchToPanel(name) {
    tabs.forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`.tab[data-tab="${name}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    Object.values(panels).forEach(p => p.classList.remove('active'));
    if (panels[name]) panels[name].classList.add('active');
  }

  // ── Utilities ──
  function escapeHTML(str) { if (!str) return ''; return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00'), today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (d.getTime() === today.getTime()) return 'Today';
    if (d.getTime() === tomorrow.getTime()) return 'Tomorrow';
    if (d.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function setPriority(priority) {
    selectedPriority = priority;
    priorityBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.priority === priority);
    });
  }

  function setDuration(minutes) {
    selectedDuration = minutes;
    durationBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.minutes) === minutes);
    });
  }

  function applyTaskTemplate(kind, previousKind = selectedTaskKind) {
    const template = taskTemplates[kind];
    if (!template) return;

    if (!editingTaskId) {
      const previousTemplateText = taskTemplates[previousKind]?.text || '';
      const currentText = taskInput.value.trim();

      if (kind === 'task') {
        if (!currentText || currentText === previousTemplateText) {
          taskInput.value = '';
        }
      } else if (!currentText || currentText === previousTemplateText || previousKind !== kind) {
        taskInput.value = template.text;
      }
    }

    if (kind === 'task') setPriority(template.priority);
    if (kind !== 'tea' && kind !== 'lunch') {
      setDuration(template.minutes);
    }
    setTimeSlot(template.timeSlot || '');
    setRecurrence(kind === 'tea' || kind === 'lunch' ? 'once' : 'once');
    syncTaskComposer();
  }

  function resetTaskComposer() {
    editingTaskId = null;
    selectedTaskKind = 'task';
    ritualBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.kind === 'task'));
    setPriority('P2');
    setDuration(15);
    setTimeSlot('');
    setRecurrence('once');
    updateTaskComposerButton();
    syncTaskComposer();
  }

  function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} min`;
    if (minutes % 60 === 0) return `${minutes / 60} hr`;
    return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  function setRecurrence(mode) {
    selectedRecurrence = mode;
    recurrenceBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function setTaskKind(kind) {
    selectedTaskKind = kind || 'task';
    ritualBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.kind === selectedTaskKind);
    });
  }

  function updateTaskComposerButton() {
    if (!btnAddTask) return;
    btnAddTask.innerHTML = editingTaskId
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Update Task`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Save Task`;
  }

  function startEditingTask(task) {
    editingTaskId = task.id;
    setTaskKind(task.kind || 'task');
    taskInput.value = task.title || '';
    setPriority(task.priority || 'P2');
    setDuration(task.durationMinutes || taskTemplates[task.kind || 'task']?.minutes || 15);
    setRecurrence(task.recurrenceMode || 'once');
    setTimeSlot(task.timeSlot || taskTemplates[task.kind || 'task']?.timeSlot || '');
    updateTaskComposerButton();
    syncTaskComposer();
    switchToPanel('tasks');
    taskInput.focus();
    taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
    if (task.attentionNeeded) {
      sendMessage({ action: 'acknowledgeReminders', taskId: task.id }).catch(() => { });
    }
    showToast('Editing reminder');
  }

  function formatSlotLabel(slot) {
    if (!slot) return '';
    const [hour, minute] = slot.split(':').map(Number);
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderTimeOptions(kind) {
    if (!timeBadges) return;
    const options = taskTimeOptions[kind] || [];
    timeBadges.innerHTML = options.map((slot) => `
      <button type="button" class="time-btn ${slot === selectedTimeSlot ? 'active' : ''}" data-time="${slot}">
        ${formatSlotLabel(slot)}
      </button>
    `).join('');
  }

  function setTimeSlot(slot) {
    selectedTimeSlot = slot || '';
    if (selectedTaskKind === 'tea' || selectedTaskKind === 'lunch') {
      renderTimeOptions(selectedTaskKind);
    }
  }

  function syncTaskComposer() {
    const isTask = selectedTaskKind === 'task';
    const recurrenceRow = document.getElementById('recurrence-row');
    const durationRow = document.getElementById('duration-row');
    const priorityRow = document.getElementById('priority-row');
    const hasTimedSlots = selectedTaskKind === 'tea' || selectedTaskKind === 'lunch';

    if (priorityRow) {
      priorityRow.style.display = isTask ? '' : 'none';
    }
    if (recurrenceRow) {
      recurrenceRow.style.display = (selectedTaskKind === 'water' || selectedTaskKind === 'screen' || hasTimedSlots) ? '' : 'none';
    }
    if (timeRow) {
      timeRow.style.display = hasTimedSlots ? '' : 'none';
      if (hasTimedSlots) {
        const options = taskTimeOptions[selectedTaskKind] || [];
        if (!selectedTimeSlot || !options.includes(selectedTimeSlot)) {
          selectedTimeSlot = options[0] || '';
        }
        renderTimeOptions(selectedTaskKind);
      }
    }
    if (durationRow) {
      const hideDuration = hasTimedSlots;
      durationRow.style.display = hideDuration ? 'none' : '';
    }
  }

  function getKindLabel(kind) {
    const labels = {
      task: 'Task',
      focus: 'Focus',
      water: 'Water',
      screen: 'Screen break',
      tea: 'Tea',
      lunch: 'Lunch'
    };
    return labels[kind] || 'Task';
  }

  function getTaskIcon(kind) {
    const icons = {
      focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="9"></circle></svg>',
      water: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C12 2 7 8 7 12a5 5 0 0 0 10 0c0-4-5-10-5-10z"></path></svg>',
      screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="8" y1="20" x2="16" y2="20"></line><line x1="12" y1="16" x2="12" y2="20"></line></svg>',
      tea: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h13v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z"></path><path d="M17 10h2a2 2 0 0 1 0 4h-2"></path></svg>',
      lunch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v8"></path><path d="M12 3v8"></path><path d="M10 11v10"></path><path d="M17 3c1.5 2 1.5 6 0 8"></path><path d="M17 11v10"></path></svg>'
    };
    return icons[kind] || icons.focus;
  }

  function getRelativeReminder(reminderAt, completed) {
    const when = new Date(reminderAt);
    if (Number.isNaN(when.getTime())) return '';
    if (completed) return 'Completed';
    const diff = when.getTime() - Date.now();
    if (diff <= 0) return 'Ready now';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `In ${mins} min`;
    const hours = Math.floor(mins / 60);
    const remainder = mins % 60;
    return remainder ? `In ${hours}h ${remainder}m` : `In ${hours}h`;
  }

  function getReminderLabel(task) {
    if (task.attentionNeeded) return 'Ready now';
    if ((task.kind === 'tea' || task.kind === 'lunch') && task.reminderAt) {
      const when = new Date(task.reminderAt);
      if (!Number.isNaN(when.getTime())) {
        return `Next ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      }
    }
    return getRelativeReminder(task.reminderAt, task.completed);
  }

  function getScheduleTag(task) {
    if ((task.kind === 'tea' || task.kind === 'lunch') && task.timeSlot) {
      return formatSlotLabel(task.timeSlot);
    }
    return '';
  }

  function showToast(message, options = {}) {
    let toast = document.querySelector('.toast');
    if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
    toast.textContent = message;
    toast.classList.toggle('reminder', options.variant === 'reminder');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  init();
  resetTaskComposer();
})();
