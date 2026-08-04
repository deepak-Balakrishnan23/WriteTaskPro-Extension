/* =========================================================
   Tasve — Notification settings

   Read by the background worker (routing), the content script (whether
   to mount, with sound, with motion) and the sidebar (the settings UI),
   so the defaults live in one place. Every value is defaulted on read
   rather than migrated on install, which keeps existing installs
   working without a version check.
   ========================================================= */

export const NOTIFICATION_DEFAULTS = Object.freeze({
  /* Off means fall back to the pre-overlay behaviour: badge and FAB only. */
  fullscreenReminders: true,
  /* Off by default on purpose. A full-screen overlay that also makes noise
     on an unmuted machine in a meeting is how extensions get uninstalled. */
  sound: false,
  soundVolume: 0.6,
  haptics: true,
  animations: true,
  reminderDurationMs: 15000
});

export const REMINDER_DURATION_CHOICES = [10000, 15000, 20000, 30000];

/* Strictly a number: Number(null) and Number('') are both 0, so a coercing
   check would read a missing volume as silence rather than falling back. */
function clamp01(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalise whatever is in storage into a complete, valid settings object.
 * Junk values fall back rather than propagating — a corrupted volume must
 * not be able to silence or blast the user.
 */
export function normalizeNotificationSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const duration = Number(source.reminderDurationMs);

  return {
    fullscreenReminders: source.fullscreenReminders !== false,
    sound: source.sound === true,
    soundVolume: clamp01(source.soundVolume, NOTIFICATION_DEFAULTS.soundVolume),
    haptics: source.haptics !== false,
    animations: source.animations !== false,
    reminderDurationMs: REMINDER_DURATION_CHOICES.includes(duration)
      ? duration
      : NOTIFICATION_DEFAULTS.reminderDurationMs
  };
}

/**
 * @param {object} storage chrome.storage.local (injected so this is testable)
 */
export async function readNotificationSettings(storage) {
  try {
    const result = await storage.get(['wtp_settings']);
    return normalizeNotificationSettings(result?.wtp_settings);
  } catch {
    /* Storage unavailable (extension reloading) must not stop a reminder. */
    return { ...NOTIFICATION_DEFAULTS };
  }
}
