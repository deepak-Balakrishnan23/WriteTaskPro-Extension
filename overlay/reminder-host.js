/* =========================================================
   Tasve — Reminder host

   The one place that knows how to put a reminder on screen: creates the
   shadow root, loads the stylesheet, plays the tone, fires the haptic,
   and swaps the overlay for the pill when the user walks away.

   Dynamically imported by content.js (a classic script, so it cannot
   `import` at the top level) and imported directly by the fallback
   window page. Both get identical behaviour from one implementation.
   ========================================================= */

import { getReminderTheme } from '../lib/reminder-theme.js';
import { playTone, createAudioContext } from '../lib/reminder-tone.js';
import { mountReminderOverlay, prefersReducedMotion } from './reminder-overlay.js';
import { createReminderPill } from './reminder-pill.js';

const CSS_URL = new URL('./reminder-overlay.css', import.meta.url).href;

let cachedSheet = null;
let cachedCssText = null;

/* Fetched once per document and reused: the overlay can be reopened from
   the pill any number of times. */
async function loadStyles(shadow) {
  if (cachedSheet && 'adoptedStyleSheets' in shadow) {
    shadow.adoptedStyleSheets = [cachedSheet];
    return;
  }

  if (cachedCssText === null) {
    const response = await fetch(CSS_URL);
    cachedCssText = await response.text();
  }

  /* Constructed stylesheets are cheaper to re-adopt, but are not available
     everywhere, so a <style> node is the fallback rather than a failure. */
  if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') {
    try {
      const sheet = new CSSStyleSheet();
      await sheet.replace(cachedCssText);
      cachedSheet = sheet;
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* Fall through to the <style> node. */
    }
  }

  const style = document.createElement('style');
  style.textContent = cachedCssText;
  shadow.appendChild(style);
}

function fireHaptic(enabled) {
  if (!enabled) return false;
  /* navigator.vibrate exists only on Android Chrome, which does not run
     extensions today. Wired up so it works wherever it ever lands, and a
     no-op everywhere else rather than a thrown TypeError. */
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      return navigator.vibrate(12);
    }
  } catch { /* some embedders throw instead of returning false */ }
  return false;
}

let audioContext = null;

function playReminderTone(theme, settings) {
  if (!settings.sound) return 0;
  /* Created lazily on the first audible reminder — constructing a context
     for a user who never enables sound is pure waste. */
  if (!audioContext) audioContext = createAudioContext();
  if (!audioContext) return 0;
  return playTone(audioContext, theme.tone, settings.soundVolume);
}

/**
 * Create a reminder host bound to one document.
 *
 * @param {object} deps
 * @param {Function} deps.onDone called with the task id when the user
 *   presses Done. The caller owns the storage side effect.
 * @param {Function} [deps.onDismiss] called with the task id on esc,
 *   close, or countdown expiry — the reminder stays pending.
 * @param {Document} [deps.doc]
 */
export function createReminderHost({ onDone, onDismiss = () => {}, doc = document } = {}) {
  const pill = createReminderPill(doc);

  let hostEl = null;
  let overlay = null;
  /* The reminder currently on screen or behind the pill. A second alarm
     replaces it rather than stacking a second overlay. */
  let current = null;
  let pendingCount = 0;

  function teardownHost() {
    overlay?.destroy();
    overlay = null;
    try { hostEl?.hidePopover?.(); } catch { /* never shown as a popover */ }
    hostEl?.remove();
    hostEl = null;
  }

  async function open(task, settings) {
    const theme = getReminderTheme(task?.kind, { title: task?.taskTitle });
    current = { task, theme, settings };

    /* Reopening from the pill, or a second alarm arriving: one overlay only. */
    teardownHost();
    pill.hide();

    hostEl = doc.createElement('div');
    hostEl.id = 'wtp-reminder-overlay';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    doc.body.appendChild(hostEl);

    try {
      if (typeof hostEl.showPopover === 'function') {
        hostEl.setAttribute('popover', 'manual');
        hostEl.showPopover();
      }
    } catch {
      /* Falls back to the max z-index on :host. */
      hostEl.removeAttribute('popover');
    }

    await loadStyles(shadow);

    overlay = mountReminderOverlay(shadow, {
      theme,
      durationMs: settings.reminderDurationMs,
      /* The extension's own toggle sits alongside the OS setting: either
         one turning motion off is enough. */
      reducedMotion: !settings.animations || prefersReducedMotion(doc.defaultView || globalThis),
      onDone: () => {
        const id = current?.task?.id;
        pendingCount = 0;
        current = null;
        teardownHost();
        pill.hide();
        onDone(id);
      },
      onDismiss: () => {
        const dismissed = current;
        teardownHost();
        /* Nothing is lost on dismiss: the pill keeps it reachable, and
           attentionNeeded stays true in storage. */
        if (dismissed) {
          pendingCount = Math.max(1, pendingCount);
          pill.show(dismissed.theme, () => { open(dismissed.task, dismissed.settings); }, pendingCount);
          onDismiss(dismissed.task?.id);
        }
      }
    });

    playReminderTone(theme, settings);
    fireHaptic(settings.haptics);
  }

  return {
    /** Show a reminder full screen. */
    async show(task, settings) {
      pendingCount += 1;
      try {
        await open(task, settings);
      } catch (err) {
        /* A broken scene must never swallow a reminder: drop straight to
           the pill so it is still reachable. */
        teardownHost();
        const theme = getReminderTheme(task?.kind, { title: task?.taskTitle });
        pill.show(theme, () => { open(task, settings).catch(() => {}); }, pendingCount);
        throw err;
      }
    },

    /** Called when storage says nothing is pending any more. */
    clear() {
      pendingCount = 0;
      current = null;
      teardownHost();
      pill.hide();
    },

    /** Reflect a pending reminder that this tab never showed (e.g. after
     *  a page load, or when the overlay ran in another tab). */
    showPill(task, settings, pending = 1) {
      if (overlay) return;
      pendingCount = pending;
      const theme = getReminderTheme(task?.kind, { title: task?.taskTitle });
      pill.show(theme, () => { open(task, settings).catch(() => {}); }, pending);
    },

    destroy() {
      teardownHost();
      pill.destroy();
    }
  };
}
