// ============================================================================
// IKVIZZ — Notification center (Phase 9).
//
// Priority Streams still decide what INTERRUPTS; this is the quiet, honest
// record of things addressed at you: mentions, reactions, missed calls, new
// moments. Every notification:
//   1. lands in the local `notifications` table (the center),
//   2. reaches open tabs live over the socket,
//   3. mirrors to Supabase public.notifications (Milestone 4 outbox),
//   4. goes out as a real Web Push — but only when you're away; presence
//      makes push redundant, and redundant notifications are noise.
// ============================================================================
import { db, now } from './db.js';
import { sendPush } from './push.js';
import { mirror } from './cloud.js';

let ioRef = null;
let isOnlineFn = () => false;

/** Called once by the socket layer — gives us live delivery + presence. */
export function wireNotify(io, isOnline) { ioRef = io; isOnlineFn = isOnline; }

export function notify(userId, kind, title, body = '', data = {}) {
  const at = now();
  const r = db.prepare(`INSERT INTO notifications (user_id, kind, title, body, data, created_at) VALUES (?,?,?,?,?,?)`)
    .run(userId, kind, String(title).slice(0, 200), String(body || '').slice(0, 300), JSON.stringify(data), at);
  const id = Number(r.lastInsertRowid);
  ioRef?.to(`user:${userId}`).emit('notify', { id, kind, title, body, data, read: 0, created_at: at });
  mirror.notification(id);

  if (!isOnlineFn(userId)) {
    for (const s of db.prepare(`SELECT * FROM push_subs WHERE user_id=?`).all(userId)) {
      sendPush(s, { title, body, kind, data })
        .then(res => { if (res.gone) db.prepare(`DELETE FROM push_subs WHERE endpoint=?`).run(s.endpoint); })
        .catch(() => { /* push service unreachable — the center still has it */ });
    }
  }
  return id;
}
