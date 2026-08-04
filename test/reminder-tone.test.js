import test from 'node:test';
import assert from 'node:assert/strict';

import { playTone, clampVolume, createAudioContext } from '../lib/reminder-tone.js';
import { getReminderTheme, REMINDER_KINDS } from '../lib/reminder-theme.js';

/* A fake AudioContext that records what was built, so the tone contract
   (single shot, under a second, ramped edges) can be asserted without any
   audio hardware. */
function fakeContext({ state = 'running' } = {}) {
  const log = { oscillators: [], gains: [], resumed: 0 };

  const param = (name, owner) => ({
    value: 0,
    setValueAtTime(value, time) { owner.events.push({ param: name, type: 'set', value, time }); return this; },
    exponentialRampToValueAtTime(value, time) { owner.events.push({ param: name, type: 'ramp', value, time }); return this; },
    linearRampToValueAtTime(value, time) { owner.events.push({ param: name, type: 'linear', value, time }); return this; }
  });

  return {
    state,
    currentTime: 10,
    destination: { name: 'destination' },
    resume() { log.resumed += 1; this.state = 'running'; },
    createOscillator() {
      const osc = { type: 'sine', events: [], started: null, stopped: null, connected: null, looped: false };
      osc.frequency = param('frequency', osc);
      osc.detune = param('detune', osc);
      osc.connect = (target) => { osc.connected = target; };
      osc.start = (t) => { osc.started = t; };
      osc.stop = (t) => { osc.stopped = t; };
      log.oscillators.push(osc);
      return osc;
    },
    createGain() {
      const node = { events: [], connected: null };
      node.gain = param('gain', node);
      node.connect = (target) => { node.connected = target; };
      log.gains.push(node);
      return node;
    },
    log
  };
}

const WATER = getReminderTheme('water').tone;

/* ── Volume ─────────────────────────────────────────────────── */

test('clampVolume keeps values in range and rejects junk', () => {
  assert.equal(clampVolume(0.6), 0.6);
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(4), 1);
  for (const junk of [NaN, undefined, null, 'loud', {}]) {
    assert.equal(clampVolume(junk), 0, `${JSON.stringify(junk)} should clamp to silence`);
  }
});

test('volume 0 plays nothing at all', () => {
  const ctx = fakeContext();
  assert.equal(playTone(ctx, WATER, 0), 0);
  assert.equal(ctx.log.oscillators.length, 0);
});

test('the master gain is set from the volume setting', () => {
  const ctx = fakeContext();
  playTone(ctx, WATER, 0.35);
  const master = ctx.log.gains[0];
  assert.equal(master.gain.value, 0.35);
  assert.equal(master.connected, ctx.destination);
});

/* ── The tone contract ──────────────────────────────────────── */

test('every kind plays a single shot under one second', () => {
  for (const kind of REMINDER_KINDS) {
    const ctx = fakeContext();
    const theme = getReminderTheme(kind);
    const started = playTone(ctx, theme.tone, 0.6);

    assert.ok(started > 0, `${kind} played nothing`);
    assert.equal(started, ctx.log.oscillators.length, `${kind} counted voices wrong`);

    for (const osc of ctx.log.oscillators) {
      assert.ok(osc.started !== null, `${kind} left a voice unstarted`);
      assert.ok(osc.stopped !== null, `${kind} left a voice running — that is a stuck oscillator`);
      const duration = osc.stopped - osc.started;
      assert.ok(duration > 0 && duration <= 1.0, `${kind} voice ran ${duration}s, over the 1s cap`);
      assert.equal(osc.looped, false, `${kind} must never loop`);
    }
  }
});

test('gain is ramped at both ends so nothing clicks', () => {
  const ctx = fakeContext();
  playTone(ctx, WATER, 0.6);
  /* The master gain is created first; every gain after it is a voice envelope. */
  const envelopes = ctx.log.gains.slice(1);
  assert.ok(envelopes.length > 0);
  for (const env of envelopes) {
    const ramps = env.events.filter((e) => e.type === 'ramp');
    assert.ok(ramps.length >= 2, 'an envelope needs both an attack and a release ramp');
    assert.ok(env.events.some((e) => e.type === 'set'), 'the envelope must start from a known value');
    assert.ok(ramps.every((e) => e.value > 0), 'exponential ramps cannot target zero');
  }
});

test('the water tone glides down, which is what makes it a drop', () => {
  const ctx = fakeContext();
  playTone(ctx, WATER, 0.6);
  const glides = ctx.log.oscillators[0].events.filter((e) => e.param === 'frequency' && e.type === 'ramp');
  assert.ok(glides.length > 0, 'no frequency glide');
  assert.ok(glides[0].value < 880, 'the glide should fall, not rise');
});

/* ── Failure never costs the reminder ───────────────────────── */

test('a suspended context is resumed rather than queueing a late tone', () => {
  const ctx = fakeContext({ state: 'suspended' });
  playTone(ctx, WATER, 0.6);
  assert.equal(ctx.log.resumed, 1);
});

test('a closed context plays nothing', () => {
  const ctx = fakeContext({ state: 'closed' });
  assert.equal(playTone(ctx, WATER, 0.6), 0);
});

test('missing context, spec or voices returns 0 instead of throwing', () => {
  assert.equal(playTone(null, WATER, 0.6), 0);
  assert.equal(playTone(fakeContext(), null, 0.6), 0);
  assert.equal(playTone(fakeContext(), { voices: [] }, 0.6), 0);
  assert.equal(playTone(fakeContext(), { voices: 'nope' }, 0.6), 0);
});

test('a throwing context is swallowed — audio must never break the overlay', () => {
  const hostile = {
    state: 'running',
    currentTime: 0,
    createGain() { throw new Error('no audio device'); }
  };
  assert.equal(playTone(hostile, WATER, 0.6), 0);
});

test('a voice with a zero or negative duration is skipped, not started', () => {
  const ctx = fakeContext();
  const started = playTone(ctx, { duration: 0.5, voices: [{ freq: 440, dur: 0 }, { freq: 440, dur: -1 }] }, 0.6);
  assert.equal(started, 0);
  assert.equal(ctx.log.oscillators.length, 0);
});

test('a voice asking for longer than the cap is truncated to it', () => {
  const ctx = fakeContext();
  playTone(ctx, { duration: 5, voices: [{ freq: 440, dur: 30 }] }, 0.6);
  const osc = ctx.log.oscillators[0];
  assert.equal(osc.stopped - osc.started, 1.0);
});

test('createAudioContext returns null rather than throwing when WebAudio is absent', () => {
  assert.equal(createAudioContext({}), null);
  assert.equal(createAudioContext({ AudioContext: function () { throw new Error('blocked'); } }), null);
});
