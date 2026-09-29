/* =========================================================
   WriteTask Pro — Content Script

   In-page UI only: selection toolbar, inline grammar underlines,
   synonyms and autocomplete. The sidebar is Chrome's side panel
   (sidebar.html); this script asks the background to open it.
   ========================================================= */

(() => {
  'use strict';
  if (window.__writeTaskProLoaded) return;
  window.__writeTaskProLoaded = true;

  // ── State ──
  let selectionToolbar = null;
  let typingGrammarTimer = null;
  let siteEnabled = true;

  // Inline grammar underline state
  let activeField = null;
  let activeIssues = [];
  let underlineLayer = null;
  let suggestionCard = null;
  let suggestionCardAnchor = null;
  let repositionRaf = 0;

  // Synonyms + autocomplete state
  let synonymCard = null;
  let ghostEl = null;
  let ghostText = '';
  let ghostField = null;
  let ghostTimer = null;

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isRuntimeAvailable() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    if (!isRuntimeAvailable()) return Promise.reject(new Error('WriteTask Pro was reloaded. Refresh the page and try again.'));
    return chrome.runtime.sendMessage(message)
      .then((response) => (response?.error ? Promise.reject(new Error(response.error)) : response));
  }

  // Opens the side panel with these messages queued for it. Call straight from a
  // click handler: the background must receive it while the user gesture is live.
  function openSidebar(...messages) {
    sendRuntimeMessage({ action: 'openSidebar', messages }).catch(() => {});
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
    if (clean.length < 8) return false;
    if (words < 3) return false;
    if (words > 200) return false; // keep per-keystroke on-device work bounded
    return true;
  }

  // ── Selection Toolbar ──
  function createSelectionToolbar() {
    selectionToolbar = document.createElement('div');
    selectionToolbar.id = 'wtp-selection-toolbar';
    selectionToolbar.innerHTML = `
      <button data-action="paraphrase" title="Rewrite selection"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg><span>Rewrite</span></button>
      <button data-action="summarize" title="Summarize selection"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg><span>Summarize</span></button>
      <button data-action="tasks" title="Extract action items"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>Tasks</span></button>
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
      hideSuggestionCard();
      hideSelectionToolbar();
      if (action === 'paraphrase') openSidebar({ action: 'paraphrase', text });
      else if (action === 'summarize') openSidebar({ action: 'summarize', content: text });
      else if (action === 'tasks') openSidebar({ action: 'extractTasks', text });
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

  // ══════════════════════════════════════
  // Inline grammar underlines (Grammarly-style)
  // ══════════════════════════════════════

  function ensureUnderlineLayer() {
    if (underlineLayer && document.body.contains(underlineLayer)) return underlineLayer;
    underlineLayer = document.createElement('div');
    underlineLayer.id = 'wtp-underline-layer';
    document.body.appendChild(underlineLayer);
    underlineLayer.addEventListener('mousedown', (e) => {
      const mark = e.target.closest('.wtp-underline');
      if (!mark) return;
      // Keep focus in the field so we can apply into it.
      e.preventDefault();
      e.stopPropagation();
      const index = Number(mark.dataset.issueIndex);
      const rect = mark.getBoundingClientRect();
      showSuggestionCard(index, { left: rect.left, right: rect.right, top: rect.top - 6, bottom: rect.top + 4 });
    });
    return underlineLayer;
  }

  function clearUnderlines() {
    if (underlineLayer) underlineLayer.innerHTML = '';
  }

  function resetGrammarState() {
    activeField = null;
    activeIssues = [];
    clearUnderlines();
    hideSuggestionCard();
    hideSynonymCard();
    clearGhost();
  }

  function getFieldPlainText(el) {
    if (!el) return '';
    if (isTextInputElement(el)) return el.value || '';
    if (el.isContentEditable) {
      // Text-node concatenation so offsets map back cleanly to DOM ranges.
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) text += node.nodeValue;
      return text;
    }
    return '';
  }

  // Map a plain-text offset to a { node, offset } point inside a contentEditable.
  function pointFromOffset(el, targetOffset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let consumed = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (targetOffset <= consumed + len) {
        return { node, offset: targetOffset - consumed };
      }
      consumed += len;
    }
    return null;
  }

  function rangeForIssueContentEditable(el, issue) {
    const startPoint = pointFromOffset(el, issue.start);
    const endPoint = pointFromOffset(el, issue.end);
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    try {
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
    } catch {
      return null;
    }
    return range;
  }

  const MIRROR_STYLE_PROPS = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight',
    'letterSpacing', 'textTransform', 'textIndent', 'textAlign', 'wordSpacing', 'tabSize'
  ];

  // Measure on-screen rects of a character range inside an input/textarea using
  // a hidden mirror element that replicates the field's text layout.
  function measureRangeWithMirror(el, start, end) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const isInput = el.tagName === 'INPUT';

    const mirror = document.createElement('div');
    MIRROR_STYLE_PROPS.forEach((p) => { mirror.style[p] = style[p]; });
    mirror.style.position = 'absolute';
    mirror.style.top = '0';
    mirror.style.left = '-99999px';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.pointerEvents = 'none';

    const value = el.value;
    const span = document.createElement('span');
    span.textContent = value.slice(start, end) || '​';
    mirror.appendChild(document.createTextNode(value.slice(0, start)));
    mirror.appendChild(span);
    mirror.appendChild(document.createTextNode(value.slice(end)));
    document.body.appendChild(mirror);

    const mirrorRect = mirror.getBoundingClientRect();
    const padLeft = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    const padTop = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
    const originX = rect.left + padLeft - el.scrollLeft;
    const originY = rect.top + padTop - el.scrollTop;
    const mOriginX = mirrorRect.left + padLeft;
    const mOriginY = mirrorRect.top + padTop;

    const rects = Array.from(span.getClientRects()).map((r) => {
      const top = originY + (r.top - mOriginY);
      const left = originX + (r.left - mOriginX);
      return { left, top, width: r.width, height: r.height, bottom: top + r.height, right: left + r.width };
    });
    mirror.remove();
    return rects;
  }

  function measureIssueRects(el, issue) {
    if (isTextInputElement(el)) {
      return measureRangeWithMirror(el, issue.start, issue.end);
    }
    if (el.isContentEditable) {
      const range = rangeForIssueContentEditable(el, issue);
      if (!range) return [];
      return Array.from(range.getClientRects()).map((r) => ({
        left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right
      }));
    }
    return [];
  }

  function renderUnderlines() {
    if (!activeField || !activeIssues.length) { clearUnderlines(); return; }
    if (!document.body.contains(activeField)) { resetGrammarState(); return; }
    const layer = ensureUnderlineLayer();
    layer.innerHTML = '';

    const fieldRect = activeField.getBoundingClientRect();
    activeIssues.forEach((issue, index) => {
      measureIssueRects(activeField, issue).forEach((r) => {
        // Clip to the visible area of the field (handles scrolled text).
        if (r.bottom < fieldRect.top + 2 || r.top > fieldRect.bottom - 2) return;
        if (r.right < fieldRect.left || r.left > fieldRect.right) return;
        if (r.width < 1) return;
        const mark = document.createElement('div');
        mark.className = 'wtp-underline';
        mark.dataset.issueIndex = String(index);
        const left = Math.max(r.left, fieldRect.left);
        mark.style.left = `${left}px`;
        mark.style.top = `${Math.min(r.bottom, fieldRect.bottom) - 3}px`;
        mark.style.width = `${Math.max(2, Math.min(r.right, fieldRect.right) - left)}px`;
        layer.appendChild(mark);
      });
    });
  }

  function scheduleReposition() {
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      if (activeField) renderUnderlines();
      if (suggestionCard) positionSuggestionCard();
    });
  }

  async function checkFieldGrammar(target) {
    const text = getFieldPlainText(target);
    if (!isGrammarEligibleText(text)) {
      if (activeField === target) resetGrammarState();
      return;
    }
    try {
      const issues = await sendRuntimeMessage({ action: 'checkGrammar', text });
      if (document.activeElement !== target) return;
      const usable = (issues || []).filter((i) => i && typeof i.start === 'number' && typeof i.suggestion === 'string');
      activeField = target;
      activeIssues = usable;
      renderUnderlines();
    } catch { /* extension reloaded or field removed */ }
  }

  function applyIssue(el, issue) {
    if (isTextInputElement(el)) {
      const val = el.value;
      el.value = val.slice(0, issue.start) + issue.suggestion + val.slice(issue.end);
      const caret = issue.start + issue.suggestion.length;
      try { el.setSelectionRange(caret, caret); } catch { /* noop */ }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      const range = rangeForIssueContentEditable(el, issue);
      if (!range) return false;
      range.deleteContents();
      range.insertNode(document.createTextNode(issue.suggestion));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  function applyAllIssues() {
    const field = activeField;
    if (!field) return;
    const full = activeIssues[0] && activeIssues[0].fullCorrection;
    if (full && isTextInputElement(field)) {
      field.value = full;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (full && field.isContentEditable) {
      field.innerText = full;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Apply back-to-front so earlier offsets remain valid.
      [...activeIssues].sort((a, b) => b.start - a.start).forEach((i) => applyIssue(field, i));
    }
    hideSuggestionCard();
    if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
    typingGrammarTimer = setTimeout(() => checkFieldGrammar(field), 200);
  }

  function hideSuggestionCard() {
    if (suggestionCard) { suggestionCard.remove(); suggestionCard = null; }
    suggestionCardAnchor = null;
  }

  function positionSuggestionCard() {
    if (!suggestionCard || !suggestionCardAnchor) return;
    const cardRect = suggestionCard.getBoundingClientRect();
    const left = Math.max(12, Math.min(suggestionCardAnchor.left, window.innerWidth - cardRect.width - 12));
    let top = suggestionCardAnchor.bottom + 8;
    if (top + cardRect.height > window.innerHeight - 12) {
      top = Math.max(12, suggestionCardAnchor.top - cardRect.height - 8);
    }
    suggestionCard.style.left = `${left}px`;
    suggestionCard.style.top = `${top}px`;
  }

  function showSuggestionCard(index, anchorRect) {
    const issue = activeIssues[index];
    if (!issue) return;
    hideSuggestionCard();

    suggestionCard = document.createElement('div');
    suggestionCard.id = 'wtp-grammar-card';
    const counter = activeIssues.length > 1 ? ` · ${index + 1}/${activeIssues.length}` : '';
    const original = (issue.original || '').trim();
    const isWord = original && !/\s/.test(original);
    suggestionCard.innerHTML = `
      <div class="wtp-grammar-rule">${escapeHTML(issue.rule || 'Suggestion')}${escapeHTML(counter)}</div>
      ${original ? `<div class="wtp-grammar-original">${escapeHTML(original)}</div>` : ''}
      <button class="wtp-grammar-apply" type="button">${escapeHTML(issue.suggestion || '(remove)')}</button>
      <div class="wtp-grammar-actions">
        ${activeIssues.length > 1 ? '<button type="button" data-action="all">Fix all</button>' : ''}
        ${isWord ? '<button type="button" data-action="dict">Add to dictionary</button>' : ''}
        <button type="button" data-action="dismiss">Dismiss</button>
      </div>
    `;
    document.body.appendChild(suggestionCard);
    // Keep the field focused while interacting with the card.
    suggestionCard.addEventListener('mousedown', (e) => e.preventDefault());

    suggestionCardAnchor = anchorRect;
    positionSuggestionCard();

    suggestionCard.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="dismiss"]')) { hideSuggestionCard(); return; }
      if (event.target.closest('[data-action="all"]')) { applyAllIssues(); return; }
      if (event.target.closest('[data-action="dict"]')) {
        const field = activeField;
        sendRuntimeMessage({ action: 'addDictionaryWord', word: original }).catch(() => {});
        hideSuggestionCard();
        if (field) {
          if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
          typingGrammarTimer = setTimeout(() => checkFieldGrammar(field), 200);
        }
        return;
      }
      if (event.target.closest('.wtp-grammar-apply')) {
        const field = activeField;
        if (!field) return;
        applyIssue(field, issue);
        hideSuggestionCard();
        if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
        typingGrammarTimer = setTimeout(() => checkFieldGrammar(field), 200);
      }
    });
  }

  // ══════════════════════════════════════
  // Synonyms on double-click
  // ══════════════════════════════════════
  function hideSynonymCard() {
    if (synonymCard) { synonymCard.remove(); synonymCard = null; }
  }

  function getWordRect(context) {
    if (context.type === 'input') {
      const rects = measureRangeWithMirror(context.el, context.start, context.end);
      return rects[0] || context.el.getBoundingClientRect();
    }
    const r = context.range.getClientRects()[0] || context.range.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
  }

  function replaceWord(context, replacement) {
    if (context.type === 'input') {
      const el = context.el;
      el.value = el.value.slice(0, context.start) + replacement + el.value.slice(context.end);
      const caret = context.start + replacement.length;
      try { el.setSelectionRange(caret, caret); } catch { /* noop */ }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      try {
        context.range.deleteContents();
        context.range.insertNode(document.createTextNode(replacement));
        context.el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* noop */ }
    }
  }

  function showSynonymCard(word, synonyms, rect, context) {
    hideSynonymCard();
    synonymCard = document.createElement('div');
    synonymCard.id = 'wtp-synonym-card';
    synonymCard.innerHTML = `
      <div class="wtp-syn-head">Synonyms for “${escapeHTML(word)}”</div>
      <div class="wtp-syn-chips">${synonyms.map((s) => `<button type="button" class="wtp-syn-chip">${escapeHTML(s)}</button>`).join('')}</div>
    `;
    document.body.appendChild(synonymCard);
    synonymCard.addEventListener('mousedown', (e) => e.preventDefault());

    const cardRect = synonymCard.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - cardRect.width - 12));
    let top = rect.bottom + 8;
    if (top + cardRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - cardRect.height - 8);
    synonymCard.style.left = `${left}px`;
    synonymCard.style.top = `${top}px`;

    synonymCard.addEventListener('click', (e) => {
      const chip = e.target.closest('.wtp-syn-chip');
      if (!chip) return;
      replaceWord(context, chip.textContent);
      hideSynonymCard();
    });
  }

  document.addEventListener('dblclick', async (e) => {
    if (!siteEnabled) return;
    const el = e.target;
    if (!isEditableElement(el)) return;

    let word = '';
    let context = null;
    if (isTextInputElement(el)) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (end <= start) return;
      word = el.value.slice(start, end).trim();
      context = { type: 'input', el, start, end };
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      word = (sel ? sel.toString() : '').trim();
      if (!word || !sel.rangeCount) return;
      context = { type: 'ce', el, range: sel.getRangeAt(0).cloneRange() };
    }
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return; // single word only

    try {
      const syns = await sendRuntimeMessage({ action: 'synonyms', word });
      if (!syns || !syns.length) return;
      showSynonymCard(word, syns, getWordRect(context), context);
    } catch { /* extension reloaded */ }
  });

  // ══════════════════════════════════════
  // Autocomplete ghost text (textarea/input, AI-gated)
  // ══════════════════════════════════════
  function clearGhost() {
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    ghostText = '';
    ghostField = null;
  }

  function caretAtEnd(el) {
    return el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length;
  }

  async function maybeAutocomplete(el) {
    if (!isTextInputElement(el) || el.tagName === 'INPUT') return; // textareas only
    if (!caretAtEnd(el)) { clearGhost(); return; }
    const value = el.value;
    if (value.trim().length < 12) { clearGhost(); return; }
    let suggestion = '';
    try { suggestion = await sendRuntimeMessage({ action: 'complete', text: value }); } catch { return; }
    if (!suggestion || document.activeElement !== el || !caretAtEnd(el)) { clearGhost(); return; }
    showGhost(el, suggestion);
  }

  function showGhost(el, suggestion) {
    clearGhost();
    const rects = measureRangeWithMirror(el, el.value.length, el.value.length);
    const rect = rects[rects.length - 1];
    if (!rect) return;
    const fieldRect = el.getBoundingClientRect();
    if (rect.top < fieldRect.top - 2 || rect.bottom > fieldRect.bottom + 2) return; // caret off-screen
    ghostEl = document.createElement('div');
    ghostEl.id = 'wtp-ghost';
    const st = window.getComputedStyle(el);
    ghostEl.style.fontFamily = st.fontFamily;
    ghostEl.style.fontSize = st.fontSize;
    ghostEl.style.fontWeight = st.fontWeight;
    ghostEl.style.fontStyle = st.fontStyle;
    ghostEl.style.letterSpacing = st.letterSpacing;
    ghostEl.textContent = (/\s$/.test(el.value) ? '' : ' ') + suggestion;
    ghostEl.style.left = `${rect.left}px`;
    ghostEl.style.top = `${rect.top}px`;
    ghostEl.style.height = `${rect.height}px`;
    ghostEl.style.maxWidth = `${Math.max(40, fieldRect.right - rect.left - 4)}px`;
    document.body.appendChild(ghostEl);
    ghostText = ghostEl.textContent;
    ghostField = el;
  }

  function acceptGhost() {
    if (!ghostField || !ghostText) return false;
    const el = ghostField;
    const insert = ghostText;
    el.value = el.value + insert;
    const caret = el.value.length;
    try { el.setSelectionRange(caret, caret); } catch { /* noop */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    clearGhost();
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && ghostField && ghostText && document.activeElement === ghostField) {
      e.preventDefault();
      acceptGhost();
    } else if (ghostField && e.key !== 'Tab' && e.key !== 'Shift') {
      // Any edit/navigation invalidates the ghost; it re-requests on input pause.
      if (e.key === 'Escape') clearGhost();
    }
  }, true);

  // ── Text Selection Listener ──
  document.addEventListener('mouseup', (e) => {
    if (!siteEnabled) return;
    if (e.target.closest('#wtp-selection-toolbar')) return;
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
        } catch { hideSelectionToolbar(); }
      } else {
        hideSelectionToolbar();
      }
    }, 50);
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#wtp-selection-toolbar')) hideSelectionToolbar();
    if (!e.target.closest('#wtp-grammar-card') && !e.target.closest('#wtp-underline-layer')) hideSuggestionCard();
    if (!e.target.closest('#wtp-synonym-card')) hideSynonymCard();
  });

  document.addEventListener('input', (e) => {
    if (!siteEnabled) return;
    const target = e.target;
    if (!isEditableElement(target)) return;
    hideSelectionToolbar();
    hideSuggestionCard();
    hideSynonymCard();
    clearGhost();
    if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
    typingGrammarTimer = setTimeout(() => checkFieldGrammar(target), 500);
    if (ghostTimer) clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => maybeAutocomplete(target), 650);
  }, true);

  // Check existing text as soon as an editable field gains focus.
  document.addEventListener('focusin', (e) => {
    if (!siteEnabled) return;
    const target = e.target;
    if (!isEditableElement(target)) return;
    if (activeField && activeField !== target) resetGrammarState();
    if (typingGrammarTimer) clearTimeout(typingGrammarTimer);
    typingGrammarTimer = setTimeout(() => checkFieldGrammar(target), 300);
  }, true);

  // Clear underlines when focus leaves editing (unless moving into our own UI).
  document.addEventListener('focusout', (e) => {
    if (!isEditableElement(e.target)) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (isEditableElement(active)) return; // another field handles itself
      if (active && active.closest && active.closest('#wtp-grammar-card')) return;
      resetGrammarState();
    }, 200);
  }, true);

  // Keep underlines aligned as the page or field scrolls / resizes.
  // Ghost text and synonym popups are position-sensitive, so just clear them.
  function onViewportShift() { scheduleReposition(); clearGhost(); hideSynonymCard(); }
  window.addEventListener('scroll', onViewportShift, true);
  window.addEventListener('resize', onViewportShift, true);

  // The side panel asks for the page text when summarizing a whole page.
  // Capped so a huge page doesn't swamp the on-device model.
  if (isRuntimeAvailable()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'getPageContent') sendResponse((document.body.innerText || '').trim().slice(0, 8000));
    });
  }

  // ── Init ──
  async function isSiteEnabled() {
    try {
      const res = await chrome.storage.local.get(['wtp_disabled_sites']);
      return !((res.wtp_disabled_sites || []).includes(location.hostname));
    } catch { return true; }
  }

  async function boot() {
    siteEnabled = await isSiteEnabled();
    if (!siteEnabled) return; // passive UI off on this site
    createSelectionToolbar();
  }

  boot();
})();
