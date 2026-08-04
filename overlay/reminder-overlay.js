/* =========================================================
   Tasve — Reminder overlay view

   Builds the full-screen overlay into a shadow root and owns its
   animations, countdown and keyboard handling. It knows nothing about
   chrome APIs, alarms or storage — callers pass a resolved theme in and
   get onDone / onDismiss back, so the same module serves both the
   in-page content script and the fallback extension window.

   destroy() must leave nothing behind: every timer, interval and
   document-level listener created here is cleared there.
   ========================================================= */

import { getReminderTheme, stripLeadingEmoji } from '../lib/reminder-theme.js';

export const ENTRANCE_MS = 380;
export const EXIT_MS = 320;
const RING_CIRCUMFERENCE = 119.38;   // 2πr, r=19; matches the CSS

/* Scene markup is data, not branching logic, so a new scene is a new
   entry rather than another `if` in the builder. */
const SCENE_LAYERS = {
  water: () => `
    ${wave('wave-1', 22)}
    ${wave('wave-2', 16)}
    ${wave('wave-3', 12)}
    ${[
      { left: 12, delay: 0, dur: 7.5 },
      { left: 28, delay: 1.8, dur: 9 },
      { left: 44, delay: 3.2, dur: 6.8 },
      { left: 61, delay: 0.9, dur: 8.4 },
      { left: 77, delay: 2.6, dur: 7.1 },
      { left: 90, delay: 4.1, dur: 9.6 }
    ].map((d) => `<span class="drop" style="left:${d.left}%;animation-delay:${d.delay}s;animation-duration:${d.dur}s"></span>`).join('')}
    ${[
      { left: 20, delay: 0.6, dur: 4.5 },
      { left: 52, delay: 2.2, dur: 5.2 },
      { left: 82, delay: 3.6, dur: 4.8 }
    ].map((r) => `<span class="ripple" style="left:${r.left}%;margin-left:-5vmax;animation-delay:${r.delay}s;animation-duration:${r.dur}s"></span>`).join('')}
  `,
  screen: () => `
    <span class="glow"></span>
    <span class="orb orb-1"></span>
    <span class="orb orb-2"></span>
    <span class="orb orb-3"></span>
  `,
  tea: () => `
    <span class="wisp wisp-1"></span>
    <span class="wisp wisp-2"></span>
    <span class="wisp wisp-3"></span>
  `,
  lunch: () => '<span class="plate"></span>',
  focus: () => `
    <span class="pulse pulse-1"></span>
    <span class="pulse pulse-2"></span>
    <span class="pulse pulse-3"></span>
  `
};

/* A 200%-wide path so the -50% drift loops seamlessly. */
function wave(className, amplitude) {
  return `
    <span class="wave ${className}">
      <svg viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,60 C120,${60 - amplitude} 240,${60 + amplitude} 360,60 C480,${60 - amplitude} 600,${60 + amplitude} 720,60 C840,${60 - amplitude} 960,${60 + amplitude} 1080,60 C1200,${60 - amplitude} 1320,${60 + amplitude} 1440,60 L1440,120 L0,120 Z" fill="currentColor"/>
      </svg>
    </span>`;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function prefersReducedMotion(win = globalThis) {
  try {
    return Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/**
 * Mount the overlay into `root` (a ShadowRoot or an element).
 *
 * @param {ShadowRoot|HTMLElement} root
 * @param {object} options
 * @param {object} options.theme resolved theme from getReminderTheme
 * @param {number} [options.durationMs] countdown length; <=0 disables auto-dismiss
 * @param {boolean} [options.reducedMotion] force the still version
 * @param {Function} [options.onDone] user completed the reminder
 * @param {Function} [options.onDismiss] esc, close button, or countdown expiry
 * @returns {{destroy: Function, element: HTMLElement}}
 */
export function mountReminderOverlay(root, options = {}) {
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  const theme = options.theme || getReminderTheme('task');
  const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 15000;
  const reduced = options.reducedMotion ?? prefersReducedMotion(win);
  const onDone = typeof options.onDone === 'function' ? options.onDone : () => {};
  const onDismiss = typeof options.onDismiss === 'function' ? options.onDismiss : () => {};

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const scene = SCENE_LAYERS[theme.scene] ? theme.scene : 'focus';

  const wrap = doc.createElement('div');
  wrap.className = 'root';
  wrap.dataset.scene = scene;
  wrap.dataset.reduced = String(reduced);
  wrap.style.setProperty('--from', theme.palette.from);
  wrap.style.setProperty('--to', theme.palette.to);
  wrap.style.setProperty('--accent', theme.palette.accent);

  wrap.innerHTML = `
    <div class="scrim"></div>
    <div class="frost"></div>
    <div class="scene" style="color:${escapeHTML(theme.palette.accent)}" aria-hidden="true">${SCENE_LAYERS[scene]()}</div>
    <div class="card" role="alertdialog" aria-modal="true" aria-labelledby="wtp-r-title" aria-describedby="wtp-r-msg">
      <button class="dismiss" type="button" aria-label="Dismiss reminder">&times;</button>
      <div class="icon" aria-hidden="true">${escapeHTML(theme.icon)}</div>
      <h1 class="headline" id="wtp-r-title">${escapeHTML(stripLeadingEmoji(theme.headline))}</h1>
      <p class="message" id="wtp-r-msg">${escapeHTML(theme.message)}</p>
      <div class="foot">
        ${totalSeconds > 0 ? `
        <div class="ring" title="Dismisses automatically">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle class="track" cx="22" cy="22" r="19"></circle>
            <circle class="bar" cx="22" cy="22" r="19"></circle>
          </svg>
          <span class="secs" aria-hidden="true">${totalSeconds}</span>
        </div>` : ''}
        <button class="done" type="button">Done</button>
      </div>
      <p class="sr-only" aria-live="polite">${totalSeconds > 0
        ? `Reminder. Dismisses automatically in ${totalSeconds} seconds.`
        : 'Reminder.'}</p>
    </div>
  `;

  root.appendChild(wrap);

  const doneBtn = wrap.querySelector('.done');
  const dismissBtn = wrap.querySelector('.dismiss');
  const secsEl = wrap.querySelector('.secs');
  const bar = wrap.querySelector('.bar');

  if (bar) {
    /* Set from the same constant the CSS uses, so a change to r cannot
       leave the ring half-drained at t=0. */
    bar.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    if (!reduced && totalSeconds > 0) bar.style.animationDuration = `${durationMs}ms`;
  }

  /* Everything cancellable, tracked in one place so destroy() is exhaustive. */
  const timers = [];
  const intervals = [];
  let destroyed = false;
  const previousFocus = doc.activeElement;

  const setTimer = (fn, ms) => { const id = win.setTimeout(fn, ms); timers.push(id); return id; };

  /* Next frame, not this one: the browser needs to paint the pre-transition
     state before .is-in flips it, or there is nothing to animate from.

     The timer is a backstop, not a nicety: requestAnimationFrame does not
     fire in a hidden or heavily throttled tab, and without it the overlay
     mounts at opacity 0 and stays invisible — present, focus-trapping, and
     completely unseen. Both paths are idempotent. */
  const reveal = () => { if (!destroyed) wrap.classList.add('is-in'); };
  if (typeof win.requestAnimationFrame === 'function') {
    win.requestAnimationFrame(() => win.requestAnimationFrame(reveal));
  }
  setTimer(reveal, 32);

  function finish(handler) {
    if (destroyed) return;
    destroyed = true;
    wrap.classList.remove('is-in');
    wrap.classList.add('is-out');
    /* Let the exit animation finish before the node goes, then hand control
       back. Timers are still tracked, so destroy() during the exit is safe. */
    const id = win.setTimeout(() => {
      cleanup();
      handler();
    }, reduced ? 160 : EXIT_MS);
    timers.push(id);
  }

  function cleanup() {
    timers.forEach((id) => win.clearTimeout(id));
    intervals.forEach((id) => win.clearInterval(id));
    timers.length = 0;
    intervals.length = 0;
    doc.removeEventListener('keydown', onKeyDown, true);
    wrap.remove();
    /* Returning focus matters most for keyboard users, who were mid-task
       when this appeared over them. */
    try { previousFocus?.focus?.({ preventScroll: true }); } catch { /* gone from the DOM */ }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(onDismiss);
      return;
    }
    /* Focus trap: only two controls, so Tab just cycles between them. */
    if (event.key === 'Tab') {
      const focusable = [dismissBtn, doneBtn].filter(Boolean);
      if (focusable.length === 0) return;
      const active = root.activeElement || doc.activeElement;
      const index = focusable.indexOf(active);
      const next = event.shiftKey
        ? focusable[(index <= 0 ? focusable.length : index) - 1]
        : focusable[(index + 1) % focusable.length];
      event.preventDefault();
      next.focus();
    }
  }

  doc.addEventListener('keydown', onKeyDown, true);
  doneBtn.addEventListener('click', () => finish(onDone));
  dismissBtn.addEventListener('click', () => finish(onDismiss));

  /* Focus the primary action, not the close button: Enter should complete
     the reminder, which is what the user almost always wants. */
  setTimer(() => { if (!destroyed) doneBtn.focus({ preventScroll: true }); }, 60);

  if (totalSeconds > 0) {
    let remaining = totalSeconds;
    const tick = win.setInterval(() => {
      remaining -= 1;
      if (secsEl) secsEl.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) win.clearInterval(tick);
    }, 1000);
    intervals.push(tick);
    setTimer(() => finish(onDismiss), durationMs);
  }

  return {
    element: wrap,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanup();
    }
  };
}
