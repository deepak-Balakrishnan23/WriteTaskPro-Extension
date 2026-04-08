/* =========================================================
   WriteTask Pro — Content Script (ALL BUGS FIXED)
   
   BUG-07 FIX: Sidebar iframe ready-state handshake with message queue
   BUG-10 FIX: Truncate page content to 8000 chars before postMessage
   BUG-13 FIX: Safer text replacement with execCommand fallback
   BUG-14 FIX: Changed shortcut to Ctrl+Shift+E (no browser conflict)
   ========================================================= */

(() => {
  'use strict';
  if (window.__writeTaskProLoaded) return;
  window.__writeTaskProLoaded = true;

  // ── State ──
  let sidebarOpen = false;
  let sidebarFrame = null;
  let sidebarReady = false;       // BUG-07 FIX
  let pendingMessages = [];       // BUG-07 FIX
  let floatingBtn = null;
  let selectionToolbar = null;
  let grammarCard = null;
  let grammarSelectionRange = null;
  let grammarEditableTarget = null;
  let typingGrammarTimer = null;

  function isRuntimeAvailable() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function getRuntimeUrl(path) {
    if (!isRuntimeAvailable()) return null;
    try {
      return chrome.runtime.getURL(path);
    } catch {
      return null;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!isRuntimeAvailable()) {
        reject(new Error('WriteTask Pro was reloaded. Refresh the page and try again.'));
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(typeof response.error === 'string' ? response.error : response.error.message || 'Request failed'));
          return;
        }
        resolve(response);
      });
    });
  }

  // ══════════════════════════════════════
  // BUG-07 FIX: Send with ready-gate
  // ══════════════════════════════════════
  function sendToSidebar(msg) {
    if (sidebarReady && sidebarFrame?.contentWindow) {
      sidebarFrame.contentWindow.postMessage(msg, '*');
    } else {
      pendingMessages.push(msg);
    }
  }

  function flushPendingMessages() {
    if (!sidebarFrame?.contentWindow) return;
    const msgs = pendingMessages.splice(0);
    msgs.forEach(msg => sidebarFrame.contentWindow.postMessage(msg, '*'));
  }

  // ── Floating Action Button ──
  function createFloatingButton() {
    floatingBtn = document.createElement('div');
    floatingBtn.id = 'wtp-fab';
    floatingBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    floatingBtn.title = 'WriteTask Pro';
    floatingBtn.addEventListener('click', toggleSidebar);
    document.body.appendChild(floatingBtn);
  }

  // ── Sidebar (iframe) ──
  function createSidebar() {
    const sidebarUrl = getRuntimeUrl('sidebar.html');
    if (!sidebarUrl) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'wtp-sidebar-wrapper';

    sidebarFrame = document.createElement('iframe');
    sidebarFrame.id = 'wtp-sidebar-frame';
    sidebarFrame.src = sidebarUrl;
    sidebarFrame.setAttribute('allow', 'microphone');

    wrapper.appendChild(sidebarFrame);
    document.body.appendChild(wrapper);

    sidebarReady = false;
    pendingMessages = [];

    window.addEventListener('message', (e) => {
      if (e.data?.source !== 'wtp-sidebar') return;

      // BUG-07 FIX: Handshake — sidebar announces it's ready
      if (e.data.action === 'sidebarReady') {
        sidebarReady = true;
        flushPendingMessages();
        return;
      }

      handleSidebarMessage(e.data);
    });
  }

  function toggleSidebar() {
    if (!isRuntimeAvailable()) return;
    const wrapper = document.getElementById('wtp-sidebar-wrapper');
    if (!wrapper) {
      createSidebar();
      if (!sidebarFrame) return;
      sidebarOpen = true;
      requestAnimationFrame(() => {
        document.getElementById('wtp-sidebar-wrapper')?.classList.add('wtp-open');
      });
    } else {
      sidebarOpen = !sidebarOpen;
      wrapper.classList.toggle('wtp-open', sidebarOpen);
    }
  }

  function handleSidebarMessage(data) {
    switch (data.action) {
      case 'closeSidebar':
        toggleSidebar();
        break;
      case 'replaceSelection':
        replaceSelectedText(data.text);
        break;
      case 'getPageContent':
        // BUG-10 FIX: Truncate to 8000 chars BEFORE postMessage to avoid main-thread freeze
        const content = (document.body.innerText || '').substring(0, 8000);
        sendToSidebar({ source: 'wtp-content', action: 'pageContent', content });
        break;
    }
  }

  function openSidebarForWriteAction(action, payload = {}) {
    if (!sidebarOpen) toggleSidebar();
    sendToSidebar({ source: 'wtp-content', action: 'openPanel', panel: 'write' });
    sendToSidebar({ source: 'wtp-content', action, ...payload });
  }

  function isTextInputElement(el) {
    return Boolean(
      el &&
      (
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel'].includes((el.type || '').toLowerCase()))
      )
    );
  }

  function isEditableElement(el) {
    return Boolean(el && (el.isContentEditable || isTextInputElement(el)));
  }

  function getEditableText(el) {
    if (!el) return '';
    if (isTextInputElement(el)) return el.value || '';
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return '';
  }

  function setEditableText(el, text) {
    if (!el) return;
    if (isTextInputElement(el)) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function countWords(text) {
    return (String(text || '').trim().match(/\b[\w']+\b/g) || []).length;
  }

  function isMeaningfulReadonlySelection(text, target) {
    if (!text) return false;
    if (isEditableElement(target)) return false;
    if (text.length < 24) return false;
    if (countWords(text) < 5) return false;
    return true;
  }

  function isGrammarEligibleText(text) {
    const clean = String(text || '').trim();
    const words = countWords(clean);
    if (clean.length < 12) return false;
    if (words < 3) return false;
    if (words > 20) return false;
    return true;
  }

  // ── Selection Toolbar ──
  function createSelectionToolbar() {
    selectionToolbar = document.createElement('div');
    selectionToolbar.id = 'wtp-selection-toolbar';
    selectionToolbar.innerHTML = `
      <button data-action="paraphrase" title="Rewrite selection"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg><span>Rewrite</span></button>
      <button data-action="summarize" title="Summarize selection"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg><span>Summarize</span></button>
    `;
    selectionToolbar.style.display = 'none';
    document.body.appendChild(selectionToolbar);

    selectionToolbar.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (!text) return;
      if (action === 'paraphrase') {
        hideGrammarCard();
        hideSelectionToolbar();
        openSidebarForWriteAction('paraphrase', { text });
        return;
      }

      if (action === 'summarize') {
        hideGrammarCard();
        hideSelectionToolbar();
        openSidebarForWriteAction('summarize', { content: text });
      }
    });
  }

  function showSelectionToolbar(x, y) {
    if (!selectionToolbar) return;
    selectionToolbar.style.display = 'flex';
    const rect = selectionToolbar.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 10);
    const top = Math.max(y - 50, 10);
    selectionToolbar.style.left = left + 'px';
    selectionToolbar.style.top = top + 'px';
  }

  function hideSelectionToolbar() {
    if (selectionToolbar) selectionToolbar.style.display = 'none';
  }

  function hideGrammarCard() {
    grammarSelectionRange = null;
    grammarEditableTarget = null;
    if (grammarCard) {
      grammarCard.remove();
      grammarCard = null;
    }
  }

  function restoreSelectionRange(range) {
    if (!range) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function pickBestGrammarIssue(issues) {
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const preferred = issues.find((issue) => issue?.rule && issue.rule !== 'Suggested correction');
    return preferred || issues[0] || null;
  }

  function showGrammarCard(issue, anchorRect, options = {}) {
    hideGrammarCard();
    grammarSelectionRange = options.range || null;
    grammarEditableTarget = options.editableTarget || null;
    grammarCard = document.createElement('div');
    grammarCard.id = 'wtp-grammar-card';
    grammarCard.innerHTML = `
      <div class="wtp-grammar-rule">${escapeHTML(issue.rule || 'Grammar suggestion')}</div>
      <button class="wtp-grammar-apply" type="button">${escapeHTML(issue.replacement || issue.suggestion || '')}</button>
      <div class="wtp-grammar-actions">
        <button type="button" data-action="dismiss">Dismiss</button>
      </div>
    `;

    document.body.appendChild(grammarCard);

    const top = window.scrollY + anchorRect.bottom + 12;
    const left = Math.min(window.scrollX + anchorRect.left, window.scrollX + window.innerWidth - grammarCard.offsetWidth - 16);
    grammarCard.style.top = `${top}px`;
    grammarCard.style.left = `${Math.max(12, left)}px`;

    grammarCard.addEventListener('click', (event) => {
      const dismiss = event.target.closest('[data-action="dismiss"]');
      if (dismiss) {
        hideGrammarCard();
        return;
      }

      const apply = event.target.closest('.wtp-grammar-apply');
      if (apply) {
        if (grammarEditableTarget) {
          setEditableText(grammarEditableTarget, issue.replacement || issue.suggestion || '');
        } else {
          restoreSelectionRange(grammarSelectionRange);
          replaceSelectedText(issue.replacement || issue.suggestion || '');
        }
        hideGrammarCard();
      }
    });
  }

  async function checkEditableGrammar(target) {
    const text = getEditableText(target);
    if (!isGrammarEligibleText(text)) {
      if (grammarEditableTarget === target) hideGrammarCard();
      return;
    }

    try {
      const issues = await sendRuntimeMessage({ action: 'checkGrammar', text });
      const firstIssue = pickBestGrammarIssue(issues);
      if (!firstIssue || !(firstIssue.replacement || firstIssue.suggestion)) {
        if (grammarEditableTarget === target) hideGrammarCard();
        return;
      }

      const rect = target.getBoundingClientRect();
      showGrammarCard(firstIssue, rect, { editableTarget: target });
    } catch { }
  }

  // ── Text Selection Listener ──
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#wtp-sidebar-wrapper') || e.target.closest('#wtp-selection-toolbar') || e.target.closest('#wtp-fab')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel.toString().trim();
      const anchorNode = sel.anchorNode;
      const targetEl = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
      if (isMeaningfulReadonlySelection(text, targetEl)) {
        try {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          showSelectionToolbar(rect.left + window.scrollX, rect.top + window.scrollY);
        } catch { hideSelectionToolbar(); }
      } else {
        hideSelectionToolbar();
      }
    }, 50);
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#wtp-selection-toolbar')) hideSelectionToolbar();
    if (!e.target.closest('#wtp-grammar-card')) hideGrammarCard();
  });

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!isEditableElement(target)) return;
    hideSelectionToolbar();
    if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
    typingGrammarTimer = setTimeout(() => {
      checkEditableGrammar(target);
    }, 500);
  }, true);

  // ══════════════════════════════════════
  // BUG-13 FIX: Safer text replacement
  // ══════════════════════════════════════
  function replaceSelectedText(newText) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const activeEl = document.activeElement;

    // Handle regular input / textarea
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'))) {
      const start = activeEl.selectionStart;
      const end = activeEl.selectionEnd;
      const val = activeEl.value;
      activeEl.value = val.substring(0, start) + newText + val.substring(end);
      activeEl.selectionStart = activeEl.selectionEnd = start + newText.length;
      activeEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Handle contentEditable — use execCommand for editor compatibility
    if (activeEl?.isContentEditable || document.designMode === 'on') {
      try {
        // execCommand preserves undo stack and editor state in rich editors
        document.execCommand('insertText', false, newText);
        return;
      } catch {
        // Fallback to range manipulation
      }
    }

    // Fallback: raw range manipulation
    try {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      sel.removeAllRanges();
    } catch { }
  }

  // ── Messages from background ──
  if (isRuntimeAvailable()) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isRuntimeAvailable()) return;

        // BUG-07 FIX: All messages use ready-gated sender
        if (msg.action === 'openSidebar') {
          if (!sidebarOpen) toggleSidebar();
          sendToSidebar({ source: 'wtp-content', action: 'openPanel', panel: msg.panel || 'write' });
        }
        if (msg.action === 'contextMenuParaphrase') {
          if (!sidebarOpen) toggleSidebar();
          sendToSidebar({ source: 'wtp-content', action: 'paraphrase', text: msg.text });
        }
        if (msg.action === 'contextMenuGrammar') {
          if (!sidebarOpen) toggleSidebar();
          sendToSidebar({ source: 'wtp-content', action: 'grammar', text: msg.text });
        }
        if (msg.action === 'contextMenuAddTask') {
          if (!sidebarOpen) toggleSidebar();
          sendToSidebar({ source: 'wtp-content', action: 'addTask', text: msg.text, url: msg.url });
        }
        if (msg.action === 'contextMenuSummarize') {
          if (!sidebarOpen) toggleSidebar();
          const content = (document.body.innerText || '').substring(0, 8000);
          sendToSidebar({ source: 'wtp-content', action: 'summarize', content });
        }
        if (msg.action === 'tasksUpdated') {
          sendToSidebar({ source: 'wtp-content', ...msg });
        }
        if (msg.action === 'reminderTriggered') {
          sendToSidebar({ source: 'wtp-content', ...msg });
        }
      });
    } catch {
      // Ignore stale extension context after reload.
    }
  }

  // ══════════════════════════════════════
  // BUG-14 FIX: Use Ctrl+Shift+E (no conflict)
  // ══════════════════════════════════════
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      toggleSidebar();
    }
  });

  // ── Init ──
  createFloatingButton();
  createSelectionToolbar();
})();
