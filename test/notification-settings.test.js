import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_DEFAULTS,
  REMINDER_DURATION_CHOICES,
  normalizeNotificationSettings,
  readNotificationSettings
} from '../lib/notification-settings.js';

/* ── Defaults ───────────────────────────────────────────────── */

test('sound is off by default and full-screen reminders are on', () => {
  assert.equal(NOTIFICATION_DEFAULTS.sound, false, 'noise must be opt-in');
  assert.equal(NOTIFICATION_DEFAULTS.fullscreenReminders, true);
  assert.equal(NOTIFICATION_DEFAULTS.soundVolume, 0.6);
  assert.equal(NOTIFICATION_DEFAULTS.reminderDurationMs, 15000);
});

test('an empty store yields the documented defaults', () => {
  assert.deepEqual(normalizeNotificationSettings(), { ...NOTIFICATION_DEFAULTS });
  assert.deepEqual(normalizeNotificationSettings({}), { ...NOTIFICATION_DEFAULTS });
});

test('an existing install with only a theme keeps working', () => {
  /* No migration runs on upgrade, so a settings object written by the old
     version must still produce a complete, valid result. */
  const settings = normalizeNotificationSettings({ theme: 'dark' });
  assert.deepEqual(settings, { ...NOTIFICATION_DEFAULTS });
});

/* ── Explicit values survive ────────────────────────────────── */

test('explicit choices are preserved', () => {
  const settings = normalizeNotificationSettings({
    fullscreenReminders: false,
    sound: true,
    soundVolume: 0.25,
    haptics: false,
    animations: false,
    reminderDurationMs: 30000
  });
  assert.deepEqual(settings, {
    fullscreenReminders: false,
    sound: true,
    soundVolume: 0.25,
    haptics: false,
    animations: false,
    reminderDurationMs: 30000
  });
});

test('every offered duration is accepted', () => {
  for (const ms of REMINDER_DURATION_CHOICES) {
    assert.equal(normalizeNotificationSettings({ reminderDurationMs: ms }).reminderDurationMs, ms);
  }
});

/* ── Corrupt values cannot hurt the user ────────────────────── */

test('a corrupt volume falls back instead of blasting or silencing', () => {
  for (const junk of [NaN, 'loud', null, {}, undefined]) {
    assert.equal(normalizeNotificationSettings({ soundVolume: junk }).soundVolume, 0.6);
  }
  assert.equal(normalizeNotificationSettings({ soundVolume: 9 }).soundVolume, 1);
  assert.equal(normalizeNotificationSettings({ soundVolume: -3 }).soundVolume, 0);
});

test('an unlisted duration falls back to 15 seconds', () => {
  for (const junk of [1, 999999, -5000, 'soon', null]) {
    assert.equal(normalizeNotificationSettings({ reminderDurationMs: junk }).reminderDurationMs, 15000);
  }
});

test('sound requires a literal true, so a truthy string cannot enable it', () => {
  assert.equal(normalizeNotificationSettings({ sound: 'yes' }).sound, false);
  assert.equal(normalizeNotificationSettings({ sound: 1 }).sound, false);
  assert.equal(normalizeNotificationSettings({ sound: true }).sound, true);
});

test('the on-by-default toggles need a literal false to turn off', () => {
  assert.equal(normalizeNotificationSettings({ haptics: 'no' }).haptics, true);
  assert.equal(normalizeNotificationSettings({ animations: 0 }).animations, true);
  assert.equal(normalizeNotificationSettings({ animations: false }).animations, false);
});

test('a non-object store does not throw', () => {
  for (const junk of ['broken', 42, true, []]) {
    assert.deepEqual(normalizeNotificationSettings(junk), { ...NOTIFICATION_DEFAULTS });
  }
});

/* ── Storage failures must not stop a reminder ──────────────── */

test('readNotificationSettings falls back when storage rejects', async () => {
  const storage = { get: async () => { throw new Error('extension reloading'); } };
  assert.deepEqual(await readNotificationSettings(storage), { ...NOTIFICATION_DEFAULTS });
});

test('readNotificationSettings reads and normalizes in one step', async () => {
  const storage = { get: async () => ({ wtp_settings: { sound: true, soundVolume: 2 } }) };
  const settings = await readNotificationSettings(storage);
  assert.equal(settings.sound, true);
  assert.equal(settings.soundVolume, 1);
  assert.equal(settings.reminderDurationMs, 15000);
});
