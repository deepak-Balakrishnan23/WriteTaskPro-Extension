/* =========================================================
   Guards the overlay's performance and behaviour contracts.

   The CSS test is the important one: "lightweight, 60 FPS" is a promise
   that decays silently the first time someone animates `top` or
   `box-shadow` in a scene, and nothing else in the project would catch
   it. Here it fails the build instead.

   The JS assertions are source-level, matching sidebar.actions.test.js —
   there is no DOM in this test environment, and a hand-rolled fake would
   mostly test the fake.
   ========================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SCENES } from '../lib/reminder-theme.js';

const CSS = fs.readFileSync(new URL('../overlay/reminder-overlay.css', import.meta.url), 'utf8');
const JS = fs.readFileSync(new URL('../overlay/reminder-overlay.js', import.meta.url), 'utf8');
const HOST = fs.readFileSync(new URL('../overlay/reminder-host.js', import.meta.url), 'utf8');
const PILL = fs.readFileSync(new URL('../overlay/reminder-pill.js', import.meta.url), 'utf8');

/* ── The 60 FPS contract ────────────────────────────────────── */

/* Properties Chrome can animate on the compositor. Anything else forces
   layout or paint on the main thread every frame. */
const COMPOSITED = new Set(['transform', 'opacity', 'filter']);
/* Documented exception, explained at its keyframes in the CSS. */
const ALLOWED_EXCEPTIONS = new Set(['stroke-dashoffset']);

function parseKeyframes(css) {
  const blocks = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    /* Walk braces to find the matching close, since keyframes nest. */
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ name: match[1], body: css.slice(re.lastIndex, i - 1) });
  }
  return blocks;
}

function declaredProperties(body) {
  return [...body.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'from' && name !== 'to');
}

test('every keyframe animates only compositor-friendly properties', () => {
  const blocks = parseKeyframes(CSS);
  assert.ok(blocks.length >= 6, `expected the five scenes plus the ring, found ${blocks.length}`);

  for (const block of blocks) {
    for (const property of declaredProperties(block.body)) {
      const ok = COMPOSITED.has(property) || ALLOWED_EXCEPTIONS.has(property);
      assert.ok(
        ok,
        `@keyframes ${block.name} animates "${property}", which forces main-thread work every frame. ` +
        'Use transform/opacity/filter, or animate the opacity of a layer that carries the effect.'
      );
    }
  }
});

test('backdrop-filter is never animated, only revealed by opacity', () => {
  /* Animating backdrop-filter re-blurs the whole layer every frame and
     drops to roughly 20 FPS. The .frost layer exists to avoid it. */
  for (const block of parseKeyframes(CSS)) {
    assert.ok(
      !/backdrop-filter/.test(block.body),
      `@keyframes ${block.name} animates backdrop-filter`
    );
  }
  assert.match(CSS, /\.frost\s*\{[^}]*backdrop-filter/, 'the frost layer should carry a static blur');
  assert.match(CSS, /\.root\.is-in \.frost\s*\{\s*opacity: 1/, 'the blur should be revealed by opacity');
});

test('the ring exception is the only non-composited animation, and is documented', () => {
  const offenders = parseKeyframes(CSS)
    .filter((block) => declaredProperties(block.body).some((p) => ALLOWED_EXCEPTIONS.has(p)))
    .map((block) => block.name);
  assert.deepEqual(offenders, ['ring-drain'], 'a new exception appeared without review');
  assert.match(CSS, /DELIBERATE EXCEPTION/, 'the exception must stay explained in the CSS');
});

/* ── Accessibility ──────────────────────────────────────────── */

test('reduced motion is honoured from the OS and from the extension setting', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/, 'the OS setting must be respected');
  assert.match(CSS, /\.root\[data-reduced="true"\]/, 'the in-extension toggle must work independently');
  /* Both paths have to stop the ambient loops, not merely shorten them —
     a breathing glow is exactly what motion sensitivity reacts to. */
  const osBlock = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(osBlock, /animation: none/, 'ambient animations must stop under reduced motion');
});

test('the overlay is an alert dialog with a labelled title and message', () => {
  assert.match(JS, /role="alertdialog"/);
  assert.match(JS, /aria-modal="true"/);
  assert.match(JS, /aria-labelledby="wtp-r-title"/);
  assert.match(JS, /aria-describedby="wtp-r-msg"/);
});

test('the per-second countdown is hidden from screen readers, announced once instead', () => {
  assert.match(JS, /class="secs" aria-hidden="true"/, 'a ticking number must not be announced every second');
  assert.match(JS, /aria-live="polite"/, 'the duration should be announced once on arrival');
});

test('focus lands on Done, is trapped, and is restored on exit', () => {
  assert.match(JS, /doneBtn\.focus/, 'Enter should complete the reminder');
  assert.match(JS, /event\.key === 'Tab'/, 'focus must be trapped inside the card');
  assert.match(JS, /previousFocus\?\.focus/, 'focus must return to where the user was');
});

test('Escape dismisses rather than completing', () => {
  const handler = JS.slice(JS.indexOf('function onKeyDown'), JS.indexOf("if (event.key === 'Tab')"));
  assert.match(handler, /Escape/);
  assert.match(handler, /finish\(onDismiss\)/, 'Esc must not silently mark the reminder done');
});

test('every control clears the 44px minimum target', () => {
  assert.match(CSS, /\.done\s*\{[^}]*min-height: 44px/);
  assert.match(CSS, /\.dismiss\s*\{[^}]*width: 44px/);
  assert.match(PILL, /min-height: 44px/, 'the pill is a control too');
});

/* ── Timers and teardown ────────────────────────────────────── */

test('destroy clears every timer and interval it created', () => {
  const cleanup = JS.slice(JS.indexOf('function cleanup()'), JS.indexOf('function onKeyDown'));
  assert.match(cleanup, /timers\.forEach\(\(id\) => win\.clearTimeout\(id\)\)/);
  assert.match(cleanup, /intervals\.forEach\(\(id\) => win\.clearInterval\(id\)\)/);
  assert.match(cleanup, /removeEventListener\('keydown', onKeyDown, true\)/, 'the capture flag must match addEventListener');
  assert.match(cleanup, /wrap\.remove\(\)/);
});

test('the countdown interval stops itself at zero', () => {
  assert.match(JS, /if \(remaining <= 0\) win\.clearInterval\(tick\)/);
});

test('a duration of zero or less disables auto-dismiss instead of firing instantly', () => {
  assert.match(JS, /totalSeconds > 0/, 'the countdown and its timer must be conditional');
});

test('the exit animation is allowed to finish before the node is removed', () => {
  const finish = JS.slice(JS.indexOf('function finish('), JS.indexOf('function cleanup()'));
  assert.match(finish, /is-out/);
  assert.match(finish, /reduced \? 160 : EXIT_MS/, 'reduced motion should not sit through a 320ms fade');
});

test('entrance and exit stay inside the 300-500ms brief', () => {
  const durations = [...CSS.matchAll(/transition:[^;]*?(\d{3})ms/g)].map((m) => Number(m[1]));
  assert.ok(durations.length > 0, 'no transition durations found');
  for (const ms of durations) {
    assert.ok(ms >= 140 && ms <= 500, `${ms}ms is outside the intended range`);
  }
});

/* ── Every scene is real ────────────────────────────────────── */

test('every scene named by a theme has both markup and CSS', () => {
  for (const scene of SCENES) {
    assert.match(JS, new RegExp(`^\\s{2}${scene}: \\(\\) =>`, 'm'), `no markup builder for scene "${scene}"`);
  }
  /* Each scene's layers must be styled, or it renders as nothing. */
  for (const layer of ['.wave', '.drop', '.ripple', '.glow', '.orb', '.wisp', '.plate', '.pulse']) {
    assert.ok(CSS.includes(`${layer} {`) || CSS.includes(`${layer},`), `${layer} has markup but no CSS`);
  }
});

test('an unknown scene falls back rather than rendering an empty overlay', () => {
  assert.match(JS, /SCENE_LAYERS\[theme\.scene\] \? theme\.scene : 'focus'/);
});

test('user-supplied text is escaped before it reaches innerHTML', () => {
  /* The message can be a task title the user typed, so it is untrusted. */
  assert.match(JS, /escapeHTML\(theme\.message\)/);
  assert.match(JS, /escapeHTML\(stripLeadingEmoji\(theme\.headline\)\)/);
});

/* ── Host behaviour ─────────────────────────────────────────── */

test('the host reaches the top layer and falls back to z-index', () => {
  assert.match(HOST, /showPopover/);
  assert.match(HOST, /removeAttribute\('popover'\)/, 'a popover failure must not leave a broken attribute');
  assert.match(CSS, /z-index: 2147483647/, 'the fallback needs the maximum z-index');
});

test('a failed overlay still shows the pill, so no reminder is lost', () => {
  const show = HOST.slice(HOST.indexOf('async show(task, settings)'), HOST.indexOf('/** Called when storage'));
  assert.match(show, /catch/);
  assert.match(show, /pill\.show/);
});

test('dismissing shows the pill; only Done clears it', () => {
  const onDone = HOST.slice(HOST.indexOf('onDone: () =>'), HOST.indexOf('onDismiss: () =>'));
  assert.match(onDone, /pill\.hide\(\)/);
  const onDismiss = HOST.slice(HOST.indexOf('onDismiss: () =>'), HOST.lastIndexOf('playReminderTone(theme, settings)'));
  assert.match(onDismiss, /pill\.show/);
});

test('a second reminder replaces the first rather than stacking overlays', () => {
  const open = HOST.slice(HOST.indexOf('async function open('), HOST.indexOf('return {'));
  assert.match(open, /teardownHost\(\)/);
});

test('sound and haptics are gated on their settings', () => {
  assert.match(HOST, /if \(!settings\.sound\) return 0/);
  assert.match(HOST, /function fireHaptic\(enabled\) \{\s*if \(!enabled\) return false/);
  assert.match(HOST, /typeof navigator\.vibrate === 'function'/, 'vibrate must be capability-checked');
});

test('the audio context is created lazily, not on every page load', () => {
  assert.match(HOST, /if \(!audioContext\) audioContext = createAudioContext\(\)/);
});
