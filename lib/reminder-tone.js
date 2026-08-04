/* =========================================================
   Tasve — Reminder tones

   Synthesised with WebAudio oscillators, so there are no audio assets
   to ship, nothing to fetch, and no CSP entry to add. Every tone is a
   single shot under one second with ramped edges — a reminder that
   loops or clicks is worse than one that stays silent.

   The AudioContext is injected rather than created here, which keeps
   this module pure enough to test against a fake.
   ========================================================= */

/* Guard rails, enforced regardless of what a theme asks for. A bad tone
   spec should produce a quiet tone, not a stuck oscillator. */
const MAX_DURATION = 1.0;
const DEFAULT_ATTACK = 0.012;
const MIN_GAIN = 0.0001;   // exponentialRampToValueAtTime cannot reach 0

export function clampVolume(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Play one reminder tone. Returns the number of voices actually started,
 * so callers (and tests) can tell a silent no-op from a real tone.
 *
 * Never throws: a reminder must still appear on screen when audio fails.
 *
 * @param {AudioContext} ctx
 * @param {{duration: number, voices: Array<object>}} spec from reminder-theme
 * @param {number} volume 0..1
 */
export function playTone(ctx, spec, volume = 0.6) {
  const level = clampVolume(volume);
  if (!ctx || level === 0) return 0;
  if (!spec || !Array.isArray(spec.voices) || spec.voices.length === 0) return 0;

  try {
    /* A context that is suspended (no user activation yet, or the tab was
       backgrounded) would otherwise queue the tone and fire it late, out of
       context. Better to drop it. */
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
    if (ctx.state === 'closed') return 0;

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = level;
    master.connect(ctx.destination);

    let started = 0;

    spec.voices.forEach((voice) => {
      const dur = Math.min(Number(voice.dur) || 0, MAX_DURATION);
      if (dur <= 0) return;

      const start = now + Math.max(0, Number(voice.start) || 0);
      const stop = start + dur;
      const peak = Math.max(MIN_GAIN, Math.min(1, Number(voice.gain) || 0.5));
      const attack = Math.min(Number(voice.attack) || DEFAULT_ATTACK, dur / 2);

      const osc = ctx.createOscillator();
      osc.type = voice.wave || 'sine';
      osc.frequency.setValueAtTime(Number(voice.freq) || 440, start);
      if (voice.detune && osc.detune) osc.detune.setValueAtTime(Number(voice.detune), start);
      /* A glide is what makes the water tone read as a drop rather than a beep. */
      if (voice.glideTo) osc.frequency.exponentialRampToValueAtTime(Number(voice.glideTo), stop);

      const env = ctx.createGain();
      /* Ramped both ends: a gain that jumps to or from zero is an audible click. */
      env.gain.setValueAtTime(MIN_GAIN, start);
      env.gain.exponentialRampToValueAtTime(peak, start + attack);
      env.gain.exponentialRampToValueAtTime(MIN_GAIN, stop);

      osc.connect(env);
      env.connect(master);
      osc.start(start);
      osc.stop(stop);
      started += 1;
    });

    return started;
  } catch {
    /* Audio is the garnish. Losing it must never cost the reminder. */
    return 0;
  }
}

/**
 * Best-effort AudioContext. Returns null when WebAudio is unavailable,
 * which callers treat as "play nothing".
 */
export function createAudioContext(win = globalThis) {
  const Ctor = win.AudioContext || win.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}
