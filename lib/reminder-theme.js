/* =========================================================
   Tasve — Reminder themes

   One pure map from a task kind to everything the overlay needs to
   render itself: the headline, the motivational line, which animated
   scene to run, the palette that scene is built from, and the tone
   spec lib/reminder-tone.js turns into sound.

   No DOM, no chrome APIs, no side effects — so the whole table is
   testable, and adding a kind means adding one entry here rather than
   touching the view.
   ========================================================= */

/* Every scene name here must have a matching `.wtp-scene-<name>` block
   in overlay/reminder-overlay.css. reminder-theme.test.js asserts that. */
export const SCENES = ['water', 'screen', 'tea', 'lunch', 'focus'];

const THEMES = {
  water: {
    icon: '💧',
    headline: '💧 Time to Drink Water',
    message: 'A glass now keeps your focus sharp for the next hour.',
    scene: 'water',
    palette: { from: '#0ea5e9', to: '#1e3a8a', accent: '#7dd3fc' },
    /* Falling drop: one voice gliding down, short and wet. */
    tone: {
      duration: 0.42,
      voices: [
        { wave: 'sine', freq: 880, glideTo: 520, start: 0, dur: 0.18, gain: 0.9 },
        { wave: 'sine', freq: 1320, glideTo: 760, start: 0.12, dur: 0.24, gain: 0.35 }
      ]
    }
  },

  screen: {
    icon: '👀',
    headline: '👀 Time for a Screen Break',
    message: 'Look 20 feet away for 20 seconds. Your eyes will thank you.',
    scene: 'screen',
    palette: { from: '#0d9488', to: '#312e81', accent: '#5eead4' },
    /* Zen bell: fundamental plus a slightly detuned partial, long decay. */
    tone: {
      duration: 0.95,
      voices: [
        { wave: 'sine', freq: 528, start: 0, dur: 0.9, gain: 0.8 },
        { wave: 'sine', freq: 792, detune: 6, start: 0, dur: 0.7, gain: 0.3 }
      ]
    }
  },

  tea: {
    icon: '🍵',
    headline: '🍵 Time for a Tea Break',
    message: 'Step away from the screen while it brews.',
    scene: 'tea',
    palette: { from: '#b45309', to: '#3f2712', accent: '#fcd34d' },
    /* Meditation tone: low, slow, nothing percussive. */
    tone: {
      duration: 0.9,
      voices: [
        { wave: 'sine', freq: 288, start: 0, dur: 0.85, gain: 0.85, attack: 0.09 },
        { wave: 'sine', freq: 432, start: 0.05, dur: 0.7, gain: 0.25, attack: 0.09 }
      ]
    }
  },

  lunch: {
    icon: '🍽️',
    headline: '🍽️ Time for Lunch',
    message: 'Real food, away from the desk. The work will wait.',
    scene: 'lunch',
    palette: { from: '#ea580c', to: '#7f1d1d', accent: '#fdba74' },
    /* Uplifting major third. */
    tone: {
      duration: 0.6,
      voices: [
        { wave: 'triangle', freq: 523.25, start: 0, dur: 0.3, gain: 0.7 },
        { wave: 'triangle', freq: 659.25, start: 0.14, dur: 0.4, gain: 0.6 }
      ]
    }
  },

  task: {
    icon: '⏰',
    headline: '⏰ Reminder',
    message: 'This is the one you asked to be reminded about.',
    scene: 'focus',
    palette: { from: '#4f46e5', to: '#1e1b4b', accent: '#a5b4fc' },
    tone: {
      duration: 0.35,
      voices: [{ wave: 'sine', freq: 660, start: 0, dur: 0.3, gain: 0.75 }]
    }
  }
};

/* background.js's getReminderTitle has a 'focus' kind that the ritual
   chips never produce. It reuses the task scene rather than getting a
   sixth one nobody can trigger. */
const KIND_ALIASES = { focus: 'task' };

export const REMINDER_KINDS = Object.keys(THEMES);

/**
 * Drop the leading emoji from a headline. The overlay and the pill both show
 * the icon separately, so the inline copy is a duplicate; the full headline
 * is still what the notification title uses.
 */
export function stripLeadingEmoji(text) {
  return String(text ?? '').replace(/^\s*\p{Extended_Pictographic}\uFE0F?\s*/u, '');
}

/**
 * Resolve a task kind to its theme. Unknown, missing and misspelled kinds
 * fall back to 'task' rather than returning undefined, because the caller
 * is a notification — it has to render something.
 *
 * @param {string} kind
 * @param {{title?: string}} [task] optional task, whose title replaces the
 *   default motivational line when the user wrote one.
 */
export function getReminderTheme(kind, task = {}) {
  const resolved = KIND_ALIASES[kind] || kind;
  const theme = THEMES[resolved] || THEMES.task;
  const custom = typeof task.title === 'string' ? task.title.trim() : '';

  return {
    kind: THEMES[resolved] ? resolved : 'task',
    icon: theme.icon,
    headline: theme.headline,
    /* A user-written title is the whole reason they set the reminder, so it
       outranks our generic encouragement. */
    message: custom || theme.message,
    scene: theme.scene,
    palette: { ...theme.palette },
    tone: { duration: theme.tone.duration, voices: theme.tone.voices.map((v) => ({ ...v })) }
  };
}
