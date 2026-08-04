/* =========================================================
   Tasve — Reminder window

   The fallback stage for reminder.html, used when there is no injectable
   tab to put the overlay in (a chrome:// page, the Web Store, or no open
   window at all).

   It runs the same overlay module the content script does, so there is
   one implementation of the scenes and one of the behaviour. The only
   difference is what happens on exit: this window closes itself, since
   there is no host page to stay pinned to and no FAB to fall back on.
   ========================================================= */

import { createReminderHost } from './overlay/reminder-host.js';
import { readNotificationSettings, NOTIFICATION_DEFAULTS } from './lib/notification-settings.js';

function getTaskId() {
  try {
    return new URL(location.href).searchParams.get('id');
  } catch {
    return null;
  }
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    /* The service worker restarting mid-flight is expected; the reminder
       is already recorded in storage, so nothing is lost. */
    return null;
  }
}

/* Nothing keeps this window meaningful once the overlay is gone, so it
   closes rather than leaving an empty popup behind. Delayed past the exit
   animation so the fade actually plays. */
function closeSoon() {
  setTimeout(() => window.close(), 360);
}

async function start() {
  const taskId = getTaskId();
  if (!taskId) {
    window.close();
    return;
  }

  const [task, settings] = await Promise.all([
    send({ action: 'getReminderTask', taskId }),
    readNotificationSettings(chrome.storage.local).catch(() => ({ ...NOTIFICATION_DEFAULTS }))
  ]);

  /* Completed or deleted between the alarm firing and the window opening. */
  if (!task) {
    window.close();
    return;
  }

  const host = createReminderHost({
    doc: document,
    onDone: (id) => {
      if (id) send({ action: 'resolveReminder', taskId: id });
      closeSoon();
    },
    /* Esc or the countdown: attentionNeeded stays set, so the badge stays
       lit and the pill appears in the next page the user visits. The pill
       inside this window would be pointless — the window is closing. */
    onDismiss: () => closeSoon()
  });

  try {
    await host.show(task, settings);
  } catch (err) {
    console.debug('Tasve: reminder window could not render the overlay', err);
    closeSoon();
  }
}

start();
