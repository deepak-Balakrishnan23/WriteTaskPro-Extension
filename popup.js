(() => {
  'use strict';

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (response?.error) reject(new Error(response.error));
          else resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }

  function canInjectIntoTab(tab) {
    const url = tab?.url || '';
    return Boolean(url) && !/^(chrome|chrome-extension|edge|about|brave|moz-extension):/i.test(url);
  }

  async function ensureSidebarReady(tabId, options = {}) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'openSidebar', ...options });
      return true;
    } catch {
      // The content script may not exist yet on already-open tabs.
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.id !== tabId || !canInjectIntoTab(tab)) {
      return false;
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content-styles.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    await chrome.tabs.sendMessage(tabId, { action: 'openSidebar', ...options });
    return true;
  }

  async function openSidebarOnActiveTab(options) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await ensureSidebarReady(tab.id, options);
    }
  }

  function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  async function initSiteToggle() {
    const section = document.getElementById('popup-site-section');
    const toggle = document.getElementById('popup-site-toggle');
    const label = document.getElementById('popup-site-label');
    if (!section || !toggle) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = hostnameFromUrl(tab?.url);
      if (!host || !canInjectIntoTab(tab)) return; // not a normal page
      section.style.display = 'block';
      if (label) label.textContent = `Active on ${host}`;
      const res = await chrome.storage.local.get(['wtp_disabled_sites']);
      const disabled = res.wtp_disabled_sites || [];
      toggle.checked = !disabled.includes(host);
      toggle.addEventListener('change', async () => {
        const cur = (await chrome.storage.local.get(['wtp_disabled_sites'])).wtp_disabled_sites || [];
        let next = cur.filter((h) => h !== host);
        if (!toggle.checked) next.push(host);
        await chrome.storage.local.set({ wtp_disabled_sites: next });
        if (tab?.id) chrome.tabs.reload(tab.id); // apply immediately
        window.close();
      });
    } catch { /* leave hidden */ }
  }

  async function init() {
    initSiteToggle();
    try {
      const settings = await chrome.storage.local.get(['wtp_settings']);
      applyTheme(settings?.wtp_settings?.theme || 'system');
      const tasks = await sendMessage({ action: 'getTasks' });
      const pendingTasks = (tasks || []).filter((task) => !task.completed);
      const container = document.getElementById('popup-tasks');
      const readyBanner = document.getElementById('popup-ready-banner');
      const readyCount = pendingTasks.filter((task) => task.attentionNeeded).length;
      const firstReadyTask = pendingTasks.find((task) => task.attentionNeeded) || null;

      if (readyCount > 0) {
        readyBanner.textContent = `${readyCount} reminder${readyCount === 1 ? '' : 's'} ready`;
        readyBanner.classList.add('show');
      } else {
        readyBanner.textContent = '';
        readyBanner.classList.remove('show');
      }

      if (!pendingTasks.length) {
        container.innerHTML = '<div class="empty-text">No reminders yet</div>';
      } else {
        pendingTasks.sort((a, b) => {
          if (a.attentionNeeded !== b.attentionNeeded) return a.attentionNeeded ? -1 : 1;
          const timeA = taskTime(a);
          const timeB = taskTime(b);
          return timeA - timeB;
        });
        container.innerHTML = pendingTasks.slice(0, 5).map((task) => `
          <button class="task-mini ${task.attentionNeeded ? 'ready' : ''}" data-task-id="${escapeHTML(task.id)}" type="button">
            <div class="task-dot ${task.attentionNeeded ? 'ready' : task.priority}"></div>
            <div class="task-mini-title">${escapeHTML(task.title)}</div>
            <div class="task-mini-time">${escapeHTML(getReminderText(task))}</div>
          </button>
        `).join('');
      }

      container.addEventListener('click', async (event) => {
        const item = event.target.closest('[data-task-id]');
        if (!item) return;
        try {
          await openSidebarOnActiveTab({ panel: 'tasks', focusTaskId: item.dataset.taskId });
        } catch { }
        window.close();
      });

      const openButton = document.getElementById('popup-open-sidebar');
      openButton.textContent = firstReadyTask ? 'Open Ready Task' : 'Open Writing Sidebar';
    } catch {
      document.getElementById('popup-tasks').innerHTML = '<div class="empty-text">Could not load tasks</div>';
    }

    document.getElementById('popup-open-sidebar').addEventListener('click', async () => {
      try {
        const tasks = await sendMessage({ action: 'getTasks' });
        const firstReadyTask = (tasks || []).find((task) => !task.completed && task.attentionNeeded) || null;
        await openSidebarOnActiveTab(
          firstReadyTask
            ? { panel: 'tasks', focusTaskId: firstReadyTask.id }
            : { panel: 'write' }
        );
      } catch { }
      window.close();
    });
  }

  function taskTime(task) {
    if (!task?.reminderAt) return Number.MAX_SAFE_INTEGER;
    const time = new Date(task.reminderAt).getTime();
    return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
  }

  function getReminderText(task) {
    if (task?.attentionNeeded) return 'Ready now';
    if (!task?.reminderAt) return 'No reminder set';
    const when = new Date(task.reminderAt);
    if (Number.isNaN(when.getTime())) return 'No reminder set';
    const diff = when.getTime() - Date.now();
    if (diff <= 0) return 'Ready now';
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return `In ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `In ${hours}h ${remainder}m` : `In ${hours}h`;
  }

  init();
})();
