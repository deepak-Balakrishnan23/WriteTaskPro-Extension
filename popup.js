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

  async function ensureSidebarReady(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'openSidebar', panel: 'write' });
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

    await chrome.tabs.sendMessage(tabId, { action: 'openSidebar', panel: 'write' });
    return true;
  }

  async function init() {
    try {
      const settings = await chrome.storage.local.get(['wtp_settings']);
      applyTheme(settings?.wtp_settings?.theme || 'system');
      const tasks = await sendMessage({ action: 'getTasks' });
      const pendingTasks = (tasks || []).filter((task) => !task.completed);
      const container = document.getElementById('popup-tasks');
      const readyBanner = document.getElementById('popup-ready-banner');
      const readyCount = pendingTasks.filter((task) => task.attentionNeeded).length;

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
          <div class="task-mini ${task.attentionNeeded ? 'ready' : ''}">
            <div class="task-dot ${task.attentionNeeded ? 'ready' : task.priority}"></div>
            <div class="task-mini-title">${escapeHTML(task.title)}</div>
            <div class="task-mini-time">${escapeHTML(getReminderText(task))}</div>
          </div>
        `).join('');
      }
    } catch {
      document.getElementById('popup-tasks').innerHTML = '<div class="empty-text">Could not load tasks</div>';
    }

    document.getElementById('popup-open-sidebar').addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await ensureSidebarReady(tab.id);
        }
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
