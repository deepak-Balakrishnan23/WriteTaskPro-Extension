/* =========================================================
   Tasve — Reminder pill

   The overlay is deliberately easy to get rid of (Esc, or wait 15
   seconds), which would make it easy to lose the reminder entirely.
   The pill is the receipt: it appears whenever a reminder is still
   pending, reopens the overlay on click, and only leaves when the user
   presses Done.

   Its own shadow root and top-layer popover, for the same reason the
   overlay has them — host page CSS and stacking cannot touch it.
   ========================================================= */

import { stripLeadingEmoji } from '../lib/reminder-theme.js';

const PILL_CSS = `
:host {
  position: fixed;
  inset: auto;
  right: 20px;
  bottom: 88px;
  z-index: 2147483647;
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  overflow: visible;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
.pill {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 16px 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(20, 20, 43, 0.82);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  opacity: 0;
  transform: translateY(8px) scale(0.96);
  transition: opacity 300ms cubic-bezier(0.16, 1, 0.3, 1),
              transform 300ms cubic-bezier(0.16, 1, 0.3, 1);
}
.pill.is-in { opacity: 1; transform: translateY(0) scale(1); }
.pill:hover { border-color: rgba(255, 255, 255, 0.36); }
.pill:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.icon { font-size: 18px; line-height: 1; }
.count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: #ef4444;
  font-size: 11px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
@media (prefers-reduced-motion: reduce) {
  .pill { transition: opacity 160ms linear; transform: none; }
  .pill.is-in { transform: none; }
}
`;

/**
 * @param {Document} doc
 * @returns {{show: Function, hide: Function, destroy: Function}}
 */
export function createReminderPill(doc = document) {
  const win = doc.defaultView || globalThis;
  let host = null;
  let button = null;
  let onClick = () => {};

  function build() {
    host = doc.createElement('div');
    host.id = 'wtp-reminder-pill';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${PILL_CSS}</style>
      <button class="pill" type="button">
        <span class="icon" aria-hidden="true">⏰</span>
        <span class="label">Reminder waiting</span>
        <span class="count" hidden>1</span>
      </button>`;
    button = shadow.querySelector('.pill');
    button.addEventListener('click', () => onClick());
    doc.body.appendChild(host);

    /* Top layer, so a page's own sticky UI cannot bury it. Falls back to
       the z-index on :host when popover is unavailable. */
    try {
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
        host.showPopover();
      }
    } catch {
      host.removeAttribute('popover');
    }
  }

  return {
    /**
     * @param {object} theme resolved reminder theme, for icon and label
     * @param {Function} handler click handler that reopens the overlay
     * @param {number} [pending] how many reminders are waiting
     */
    show(theme, handler, pending = 1) {
      onClick = typeof handler === 'function' ? handler : () => {};
      if (!host) build();

      const shadow = host.shadowRoot;
      shadow.querySelector('.icon').textContent = theme?.icon || '⏰';
      /* The pill shows the icon separately, so the headline's own emoji goes. */
      shadow.querySelector('.label').textContent = theme?.headline
        ? stripLeadingEmoji(theme.headline)
        : 'Reminder waiting';

      const count = shadow.querySelector('.count');
      count.hidden = pending <= 1;
      count.textContent = String(Math.min(pending, 9));

      /* Timer backstop for the same reason as the overlay: rAF does not run
         in a hidden tab, and a pill stuck at opacity 0 is a lost reminder. */
      const reveal = () => button?.classList.add('is-in');
      if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(reveal);
      win.setTimeout(reveal, 32);
    },

    hide() {
      if (!host || !button) return;
      button.classList.remove('is-in');
      /* Outlive the exit transition before removing the node. */
      win.setTimeout(() => {
        try { host?.hidePopover?.(); } catch { /* never shown as a popover */ }
        host?.remove();
        host = null;
        button = null;
      }, 320);
    },

    destroy() {
      try { host?.hidePopover?.(); } catch { /* never shown as a popover */ }
      host?.remove();
      host = null;
      button = null;
    }
  };
}
