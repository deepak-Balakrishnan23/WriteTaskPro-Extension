/* =========================================================
   WriteTask Pro — Content Script

   Runs on every page: the floating button, the selection toolbar,
   the inline grammar card, and the sidebar iframe host.

   Known limitation, by design until Phase 1: applying a suggestion
   replaces the whole field, so it is refused on any contentEditable
   that holds markup. Replacing just the issue's range needs
   character offsets from the grammar engine.
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
      // Touching chrome.runtime after the extension reloads throws; that is
      // the signal we are testing for, so there is nothing to report.
      return false;
    }
  }

  function getRuntimeUrl(path) {
    if (!isRuntimeAvailable()) return null;
    try {
      return chrome.runtime.getURL(path);
    } catch (err) {
      logDebug('getURL failed', err);
      return null;
    }
  }

  /* Bare `catch {}` is how a ReferenceError in showGrammarCard went
     unnoticed long enough to ship — the inline grammar card threw on
     every single invocation and nothing ever surfaced it. */
  function logDebug(message, err) {
    if (err) console.debug('[WriteTask Pro]', message, err);
    else console.debug('[WriteTask Pro]', message);
  }

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* The origin of our own extension pages, used to authenticate messages
     that claim to come from the sidebar iframe. */
  const EXTENSION_ORIGIN = (() => {
    const url = getRuntimeUrl('');
    return url ? url.replace(/\/$/, '') : null;
  })();

  /* Without this check, any page could post
     {source:'wtp-sidebar', action:'replaceSelection', text:'...'} to its own
     window and we would write that text into whatever the user was typing
     in — landing inside the host editor's undo stack via execCommand.
     Checking event.source and event.origin is what makes the channel real:
     data.source is attacker-controlled, the other two are not. */
  function isTrustedSidebarMessage(event) {
    if (!sidebarFrame || event.source !== sidebarFrame.contentWindow) return false;
    if (EXTENSION_ORIGIN && event.origin !== EXTENSION_ORIGIN) return false;
    return event.data?.source === 'wtp-sidebar';
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
  /* Targeted at the extension origin rather than a wildcard, so the host
     page never receives a copy of what we send our own sidebar. If we
     cannot determine our origin the extension context is already gone, so
     this fails closed rather than broadcasting. */
  function postToSidebar(msg) {
    if (!EXTENSION_ORIGIN) {
      logDebug('not posting to sidebar: extension origin unknown');
      return;
    }
    sidebarFrame.contentWindow.postMessage(msg, EXTENSION_ORIGIN);
  }

  function sendToSidebar(msg) {
    if (sidebarReady && sidebarFrame?.contentWindow) {
      postToSidebar(msg);
    } else {
      pendingMessages.push(msg);
    }
  }

  function flushPendingMessages() {
    if (!sidebarFrame?.contentWindow) return;
    pendingMessages.splice(0).forEach(postToSidebar);
  }

  // ── Floating Action Button ──
  /* A real <button>, not a <div> with a click handler — the div was not
     focusable, exposed no role, and had no accessible name beyond a title
     attribute, so keyboard and screen reader users could not open the
     sidebar at all. */
  function createFloatingButton() {
    floatingBtn = document.createElement('button');
    floatingBtn.id = 'wtp-fab';
    floatingBtn.type = 'button';
    floatingBtn.setAttribute('aria-label', 'Open WriteTask Pro');
    floatingBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    floatingBtn.title = 'WriteTask Pro';
    floatingBtn.addEventListener('click', toggleSidebar);
    document.body.appendChild(floatingBtn);
  }

  async function refreshReminderIndicator() {
    if (!floatingBtn) return;
    try {
      const tasks = await sendRuntimeMessage({ action: 'getTasks' });
      const readyCount = (tasks || []).filter((task) => !task.completed && task.attentionNeeded).length;
      floatingBtn.classList.toggle('wtp-has-alert', readyCount > 0);
      floatingBtn.dataset.reminderCount = readyCount > 0 ? String(Math.min(readyCount, 9)) : '';
    } catch (err) {
      logDebug('could not refresh reminder indicator', err);
      floatingBtn.classList.remove('wtp-has-alert');
      floatingBtn.dataset.reminderCount = '';
    }
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
      if (!isTrustedSidebarMessage(e)) return;

      // Handshake — the sidebar announces it is ready to receive.
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
        const content = (document.body.innerText || '').trim();
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

  /* True when a contentEditable holds markup we would destroy by replacing
     its text: links, bold runs, lists, embeds. A bare <br> does not count. */
  function hasRichContent(el) {
    if (!el?.isContentEditable) return false;
    return Array.from(el.childNodes).some(
      (node) => node.nodeType === Node.ELEMENT_NODE && node.nodeName !== 'BR'
    );
  }

  /* setEditableText is gone. It replaced the entire field, which discarded
     every link, list and bold run in a rich editor. Suggestions are now
     applied to just the issue's span — see applyIssueToField. */

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
    const maxLeft = window.scrollX + window.innerWidth - rect.width - 10;
    const left = Math.max(window.scrollX + 10, Math.min(x, maxLeft));
    const preferredTop = y + 12;
    const maxTop = window.scrollY + window.innerHeight - rect.height - 10;
    const top = Math.max(window.scrollY + 10, Math.min(preferredTop, maxTop));
    selectionToolbar.style.left = `${left}px`;
    selectionToolbar.style.top = `${top}px`;
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
    // Spelling first: it is the least debatable and cheapest to accept.
    const bySeverity = { spelling: 0, grammar: 1, style: 2 };
    return [...issues]
      .filter((issue) => issue?.replacements?.length)
      .sort((a, b) => (bySeverity[a.severity] ?? 3) - (bySeverity[b.severity] ?? 3) || a.offset - b.offset)[0] || null;
  }

  /* An issue's offsets describe the text at the moment it was checked. The
     user keeps typing, so verify the span still holds what was flagged
     before touching anything. Applying a stale issue would corrupt text
     that was never reported. */
  function isIssueStale(text, issue) {
    if (typeof text !== 'string' || !issue) return true;
    const end = issue.offset + issue.length;
    if (issue.offset < 0 || end > text.length) return true;
    return text.slice(issue.offset, end) !== issue.problemText;
  }

  /* Maps a character offset in an element's text to a DOM Range, so a
     suggestion can be applied to just that span. Only walks text nodes,
     which is why rich fields are still declined. */
  function rangeForOffset(root, offset, length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const nodeLength = node.textContent.length;
      if (!startNode && seen + nodeLength >= offset) {
        startNode = node;
        startOffset = offset - seen;
      }
      if (startNode && seen + nodeLength >= offset + length) {
        endNode = node;
        endOffset = offset + length - seen;
        break;
      }
      seen += nodeLength;
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  /* Applies one replacement to only the issue's span.

     For inputs and textareas setRangeText is used, which the browser
     records on the field's native undo stack — so the user can press
     Ctrl+Z. That is the whole reason the offsets in the issue contract
     matter: the previous version replaced the entire field, discarding
     every link, list and bold run in a rich editor. */
  function applyIssueToField(el, issue, replacement) {
    const text = getEditableText(el);
    if (isIssueStale(text, issue)) return 'stale';

    const end = issue.offset + issue.length;
    const insert = replacement.kind === 'insertAfter'
      ? issue.problemText + replacement.text
      : replacement.kind === 'remove' ? '' : replacement.text;

    if (isTextInputElement(el)) {
      el.setRangeText(insert, issue.offset, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'applied';
    }

    if (el.isContentEditable) {
      if (hasRichContent(el)) return 'rich';
      const range = rangeForOffset(el, issue.offset, issue.length);
      if (!range) return 'stale';

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      let ok = false;
      try {
        ok = document.execCommand('insertText', false, insert);
      } catch (err) {
        logDebug('execCommand insertText failed on range', err);
      }
      if (!ok) {
        range.deleteContents();
        if (insert) range.insertNode(document.createTextNode(insert));
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'applied';
    }

    return 'unsupported';
  }

  const SEVERITY_LABELS = {
    spelling: 'Spelling',
    grammar: 'Grammar',
    style: 'Style'
  };

  function showGrammarCard(issue, anchorRect, options = {}) {
    hideGrammarCard();
    grammarSelectionRange = options.range || null;
    grammarEditableTarget = options.editableTarget || null;

    grammarCard = document.createElement('div');
    grammarCard.id = 'wtp-grammar-card';
    grammarCard.setAttribute('role', 'dialog');
    grammarCard.setAttribute('aria-label', 'Writing suggestion');

    // Offer every replacement the engine returned, not just the first.
    const buttons = issue.replacements
      .slice(0, 3)
      .map((replacement, index) => {
        const label = replacement.kind === 'remove'
          ? `Remove “${escapeHTML(issue.problemText)}”`
          : escapeHTML(replacement.text);
        return `<button class="wtp-grammar-apply" type="button" data-index="${index}">${label}</button>`;
      })
      .join('');

    grammarCard.innerHTML = `
      <div class="wtp-grammar-rule">${escapeHTML(SEVERITY_LABELS[issue.severity] || 'Suggestion')}</div>
      <div class="wtp-grammar-message">${escapeHTML(issue.message)}</div>
      ${buttons}
      <div class="wtp-grammar-actions">
        <button type="button" data-action="dismiss">Dismiss</button>
      </div>
    `;

    document.body.appendChild(grammarCard);

    const top = window.scrollY + anchorRect.bottom + 12;
    const left = Math.min(window.scrollX + anchorRect.left, window.scrollX + window.innerWidth - grammarCard.offsetWidth - 16);
    grammarCard.style.top = `${top}px`;
    grammarCard.style.left = `${Math.max(12, left)}px`;

    // Keyboard users could not reach this card at all before.
    grammarCard.querySelector('.wtp-grammar-apply, [data-action="dismiss"]')?.focus();
    grammarCard.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        hideGrammarCard();
      }
    });

    grammarCard.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="dismiss"]')) {
        hideGrammarCard();
        return;
      }

      const apply = event.target.closest('.wtp-grammar-apply');
      if (!apply) return;

      const replacement = issue.replacements[Number(apply.dataset.index)];
      if (!replacement) return;

      if (!grammarEditableTarget) {
        restoreSelectionRange(grammarSelectionRange);
        replaceSelectedText(replacement.text);
        hideGrammarCard();
        return;
      }

      const outcome = applyIssueToField(grammarEditableTarget, issue, replacement);
      if (outcome === 'applied') {
        hideGrammarCard();
        return;
      }

      // Say what happened rather than appearing to do nothing.
      const messages = {
        rich: 'Cannot apply here without losing formatting',
        stale: 'The text changed — checking again',
        unsupported: 'Cannot apply here'
      };
      const notice = grammarCard.querySelector('.wtp-grammar-message');
      if (notice) notice.textContent = messages[outcome] || messages.unsupported;
      grammarCard.querySelectorAll('.wtp-grammar-apply').forEach((btn) => { btn.disabled = true; });
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
    } catch (err) {
      logDebug('inline grammar check failed', err);
    }
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
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
          const anchorRect = rects[rects.length - 1] || range.getBoundingClientRect();
          showSelectionToolbar(anchorRect.right + window.scrollX - 20, anchorRect.bottom + window.scrollY);
        } catch (err) {
          logDebug('could not position selection toolbar', err);
          hideSelectionToolbar();
        }
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
      } catch (err) {
        logDebug('execCommand insertText failed, falling back to range', err);
      }
    }

    // Fallback: raw range manipulation
    try {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      sel.removeAllRanges();
    } catch (err) {
      logDebug('could not replace selection', err);
    }
  }

  // ── Messages from background ──
  if (isRuntimeAvailable()) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isRuntimeAvailable()) return;

        // BUG-07 FIX: All messages use ready-gated sender
        if (msg.action === 'openSidebar') {
          if (!sidebarOpen) toggleSidebar();
          sendToSidebar({
            source: 'wtp-content',
            action: 'openPanel',
            panel: msg.panel || 'write',
            focusTaskId: msg.focusTaskId || null
          });
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
          const content = (document.body.innerText || '').trim();
          sendToSidebar({ source: 'wtp-content', action: 'summarize', content });
        }
        if (msg.action === 'tasksUpdated') {
          sendToSidebar({ source: 'wtp-content', ...msg });
          refreshReminderIndicator();
        }
        if (msg.action === 'reminderTriggered') {
          sendToSidebar({ source: 'wtp-content', ...msg });
          refreshReminderIndicator();
        }
      });
    } catch (err) {
      // A stale extension context after reload is expected; anything else is not.
      logDebug('could not register runtime listener', err);
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
  refreshReminderIndicator();
})();
