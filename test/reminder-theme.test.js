import test from 'node:test';
import assert from 'node:assert/strict';

import { getReminderTheme, REMINDER_KINDS, SCENES } from '../lib/reminder-theme.js';

/* ── Every kind resolves to something renderable ───────────── */

test('every kind resolves to a complete theme', () => {
  for (const kind of REMINDER_KINDS) {
    const theme = getReminderTheme(kind);
    assert.ok(theme.icon, `${kind} has no icon`);
    assert.ok(theme.headline, `${kind} has no headline`);
    assert.ok(theme.message, `${kind} has no message`);
    assert.ok(SCENES.includes(theme.scene), `${kind} points at an unknown scene: ${theme.scene}`);
    for (const stop of ['from', 'to', 'accent']) {
      assert.match(theme.palette[stop], /^#[0-9a-f]{6}$/i, `${kind} palette.${stop} is not a hex colour`);
    }
    assert.ok(theme.tone.voices.length > 0, `${kind} has no tone voices`);
  }
});

test('the water and screen headlines match the brief', () => {
  assert.equal(getReminderTheme('water').headline, '💧 Time to Drink Water');
  assert.equal(getReminderTheme('screen').headline, '👀 Time for a Screen Break');
});

/* ── Unknown input still produces a notification ───────────── */

test('unknown, missing and misspelled kinds fall back to task', () => {
  for (const kind of ['bogus', '', null, undefined, 42, 'Water']) {
    const theme = getReminderTheme(kind);
    assert.equal(theme.kind, 'task', `${JSON.stringify(kind)} did not fall back`);
    assert.ok(theme.headline, 'the fallback must still be renderable');
  }
});

test("background's focus kind reuses the task scene rather than breaking", () => {
  const theme = getReminderTheme('focus');
  assert.equal(theme.scene, 'focus');
  assert.ok(theme.headline);
});

/* ── The user's own words win ───────────────────────────────── */

test("a user-written title replaces the generic message", () => {
  const theme = getReminderTheme('water', { title: 'Finish the 1L bottle' });
  assert.equal(theme.message, 'Finish the 1L bottle');
});

test('a blank or whitespace title falls back to the motivational line', () => {
  for (const title of ['', '   ', null, undefined, 7]) {
    const theme = getReminderTheme('water', { title });
    assert.equal(theme.message, getReminderTheme('water').message, `title ${JSON.stringify(title)} leaked through`);
  }
});

/* ── Callers cannot corrupt the table ───────────────────────── */

test('themes are returned as copies, so a caller cannot mutate the table', () => {
  const first = getReminderTheme('water');
  first.palette.from = '#000000';
  first.tone.voices[0].freq = 1;
  const second = getReminderTheme('water');
  assert.notEqual(second.palette.from, '#000000', 'palette is shared by reference');
  assert.notEqual(second.tone.voices[0].freq, 1, 'tone voices are shared by reference');
});

test('every scene name is claimed by at least one kind', () => {
  const used = new Set(REMINDER_KINDS.map((kind) => getReminderTheme(kind).scene));
  for (const scene of SCENES) {
    assert.ok(used.has(scene), `scene "${scene}" has CSS but no kind uses it`);
  }
});
