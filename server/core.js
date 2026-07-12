// ============================================================================
// IKVIZZ — Core domain actions shared by the REST API and the socket layer.
// Sending a message is not "insert a row": the brain classifies it, extracts
// signals (promises, ideas, decisions), grows the timeline, and feeds memory.
// ============================================================================
import { db, now, ftsIndex } from './db.js';
import { classifyPriority, detectSignals } from './brain.js';
import { mirror } from './cloud.js';
import { notify, pushMessage } from './notify.js';

export function getRelationship(userId, otherId) {
  return db.prepare(`SELECT * FROM relationships WHERE user_id=? AND other_id=?`).get(userId, otherId);
}

export const MOOD_TAGS = ['joy', 'love', 'hyped', 'jk', 'unsure', 'serious', 'down', 'blown', 'skull', 'heartbreak', 'cry',
  // IKVIZZ Vibes — proprietary ceramic emoji
  'groan', 'chrome', 'vibepass', 'braincell', 'overthink', 'tea'];

export function sendMessage({ conversationId, senderId, body, replyTo = null, kind = 'text', attachment = null, effect = null, silent = false, unlockAt = null, mood = null, forwarded = false, pollOptions = null, location = null, viewOnce = false }) {
  const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conversationId);
  if (!convo) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  if (!['text', 'sealed'].includes(kind)) kind = 'text';

  const text = String(body || '').trim();
  if (!text && !attachment && !location) throw Object.assign(new Error('Empty message.'), { status: 400 });
  if (text.length > (kind === 'sealed' ? 24000 : 8000)) throw Object.assign(new Error('Message too long.'), { status: 400 });

  // Attachment metadata must be a server-issued upload descriptor
  let att = null;
  if (attachment && typeof attachment === 'object') {
    const { url, name, type, size } = attachment;
    if (typeof url === 'string' && url.startsWith('/files/') && !url.includes('..')) {
      att = { url, name: String(name || 'file').slice(0, 200), type: String(type || '').slice(0, 100), size: Number(size) || 0 };
    }
  }

  // Replies must quote a message from THIS conversation
  if (replyTo) {
    const target = db.prepare(`SELECT conversation_id FROM messages WHERE id=?`).get(Number(replyTo));
    if (!target || target.conversation_id !== convo.id) replyTo = null;
  }

  // Receiver-side closeness drives priority for DMs
  let closeness = 2;
  let otherId = null;
  if (convo.kind === 'dm') {
    otherId = convo.a_id === senderId ? convo.b_id : convo.a_id;
    const rel = getRelationship(otherId, senderId); // how the RECEIVER ranks the sender
    if (rel) closeness = rel.closeness;
  }

  // Time Capsule: sealed against TIME. Validate window (must be future, ≤ 50y).
  let capsuleAt = null;
  if (unlockAt) {
    const at = Number(unlockAt);
    if (Number.isFinite(at) && at > Date.now() && at < Date.now() + 50 * 365 * 86_400_000) capsuleAt = at;
    else throw Object.assign(new Error('Capsule date must be in the future (and within 50 years).'), { status: 400 });
  }

  // Sealed (E2E) and capsule messages are opaque to the brain — no
  // classification, no signal extraction, no search index (a capsule that
  // shows up in search isn't sealed against time at all).
  const sealed = kind === 'sealed';
  const opaque = sealed || !!capsuleAt;
  let priority = opaque || silent ? 'normal' : classifyPriority(text, closeness);
  const signals = opaque ? [] : detectSignals(text);
  if (capsuleAt) signals.push({ type: 'capsule', at: capsuleAt });
  if (silent && !opaque) signals.push({ type: 'silent' }); // a thought, not an interruption
  if (!opaque && MOOD_TAGS.includes(mood)) signals.push({ type: 'mood', kind: mood }); // Emotion Layer
  if (!opaque && forwarded) signals.push({ type: 'fwd' }); // honest provenance

  // Location share (free — OpenStreetMap, no API key). Coordinates ride as a signal.
  if (!opaque && location && typeof location === 'object') {
    const lat = Number(location.lat), lng = Number(location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      signals.push({ type: 'location', lat: +lat.toFixed(6), lng: +lng.toFixed(6), live: !!location.live });
    }
  }

  // View-once photo: a self-destructing image. Once the recipient opens it, the
  // attachment is wiped server-side, so it stays gone even after a reload. DM
  // only (single recipient), and only meaningful with an image attachment.
  if (!opaque && viewOnce && att && convo.kind === 'dm' && /^image\//.test(att.type)) {
    signals.push({ type: 'viewonce' });
  }

  // Polls: the question is the body, options ride as a signal, votes live apart
  if (!opaque && Array.isArray(pollOptions)) {
    const opts = pollOptions.map(o => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    if (opts.length < 2) throw Object.assign(new Error('A poll needs at least two options.'), { status: 400 });
    kind = 'poll';
    signals.push({ type: 'poll', options: opts });
  }

  // @mentions in Living Spaces: matched against member usernames
  if (!opaque && convo.kind === 'space' && /@\w/.test(text)) {
    const members = db.prepare(`
      SELECT u.id, u.username FROM space_members sm JOIN users u ON u.id = sm.user_id WHERE sm.space_id=?
    `).all(convo.space_id);
    const named = [...text.matchAll(/@([a-z0-9_]+)/gi)].map(m => m[1].toLowerCase());
    const hit = members.filter(m => named.includes(m.username) && m.id !== senderId).map(m => m.id);
    if (hit.length) signals.push({ type: 'mention', users: hit });
  }

  // Message effects (/confetti, /shake, /flip) ride along as a signal
  if (!opaque && ['confetti', 'shake', 'flip'].includes(effect)) {
    signals.push({ type: 'effect', kind: effect });
  }

  const r = db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, body, priority, signals, reply_to, created_at, kind, attachment, unlock_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(conversationId, senderId, text, priority, JSON.stringify(signals), replyTo, now(), kind, att ? JSON.stringify(att) : null, capsuleAt);
  const messageId = Number(r.lastInsertRowid);

  if (!opaque && text) ftsIndex('message', messageId, conversationId, text);

  // Promise detection → tracked commitment + timeline event
  const promiseSignal = signals.find(s => s.type === 'promise');
  if (promiseSignal && otherId) {
    db.prepare(`INSERT INTO promises (user_id, to_id, message_id, body, due_hint, created_at) VALUES (?,?,?,?,?,?)`)
      .run(senderId, otherId, messageId, text, promiseSignal.due || '', now());
    addTimelineEvent(senderId, otherId, 'promise', text.slice(0, 120));
  }
  const ideaSignal = signals.find(s => s.type === 'idea');
  if (ideaSignal && otherId) addTimelineEvent(senderId, otherId, 'idea', text.slice(0, 120));

  // First-message milestone
  if (otherId) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=?`).get(conversationId).c;
    if (count === 1) addTimelineEvent(senderId, otherId, 'first_message', 'First conversation');
  }

  mirror.message(messageId); // Milestone 4: core messaging reaches Supabase

  const sender = db.prepare(`SELECT id, username, display_name, avatar_hue, avatar_url, avatar_config FROM users WHERE id=?`).get(senderId);

  // @mentions land in the notification center (and push, if they're away)
  const mentionSignal = signals.find(s => s.type === 'mention');
  if (mentionSignal) {
    for (const uid of mentionSignal.users) {
      notify(uid, 'mention', `${sender.display_name} mentioned you`, text.slice(0, 140), { conversationId });
    }
  }

  // Every message pushes to away recipients (this is why notifications now
  // arrive without opening the app). No notification-center row — just the
  // push. Time capsules stay silent until they unlock; @mentioned users were
  // already notified above, so skip them here.
  if (!capsuleAt) {
    const mentioned = new Set(mentionSignal?.users || []);
    const preview = sealed ? 'Sent you a message'
      : text ? text.slice(0, 140)
        : att ? `Sent ${/^image\//.test(att.type || '') ? 'a photo' : 'an attachment'}`
          : 'New message';
    if (convo.kind === 'dm' && otherId && !mentioned.has(otherId)) {
      pushMessage(otherId, sender.display_name, preview, { conversationId });
    } else if (convo.kind === 'space') {
      const sp = db.prepare(`SELECT name FROM spaces WHERE id=?`).get(convo.space_id);
      for (const mem of db.prepare(`SELECT user_id FROM space_members WHERE space_id=? AND user_id!=?`).all(convo.space_id, senderId)) {
        if (!mentioned.has(mem.user_id)) pushMessage(mem.user_id, `${sender.display_name} · ${sp?.name || 'Space'}`, preview, { conversationId });
      }
    }
  }

  return { ...rowToMessage(db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId)), sender };
}

export function rowToMessage(row) {
  return { ...row, signals: JSON.parse(row.signals || '[]'), attachment: row.attachment ? JSON.parse(row.attachment) : null };
}

// Legacy icon reactions + the IKVIZZ mood blobs
const REACTION_KINDS = ['heart', 'flame', 'check', 'bulb', 'smile', 'star', ...MOOD_TAGS];

/** Aggregate reactions for a set of message ids → { [id]: [{kind, count, mine}] } */
export function reactionsFor(messageIds, viewerId) {
  if (!messageIds.length) return {};
  const ph = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT message_id, kind, COUNT(*) AS count,
           SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine
    FROM reactions WHERE message_id IN (${ph}) GROUP BY message_id, kind
  `).all(viewerId, ...messageIds);
  const out = {};
  for (const r of rows) (out[r.message_id] ||= []).push({ kind: r.kind, count: r.count, mine: !!r.mine });
  return out;
}

/** Compact preview of the replied-to message for quoting in the UI. */
export function replyPreviewFor(messageIds) {
  if (!messageIds.length) return {};
  const ph = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.id, m.reply_to, r.kind AS rkind, r.deleted AS rdeleted,
           r.body AS rbody, u.display_name AS rname
    FROM messages m JOIN messages r ON r.id = m.reply_to JOIN users u ON u.id = r.sender_id
    WHERE m.id IN (${ph})
  `).all(...messageIds);
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      id: r.reply_to, name: r.rname,
      body: r.rdeleted ? 'Message removed' : r.rkind === 'sealed' ? 'Encrypted message' : r.rbody.slice(0, 120),
    };
  }
  return out;
}

export function toggleReaction(messageId, userId, kind) {
  if (!REACTION_KINDS.includes(kind)) throw Object.assign(new Error('Unknown reaction.'), { status: 400 });
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m || m.deleted) throw Object.assign(new Error('Message not found.'), { status: 404 });
  const existing = db.prepare(`SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND kind=?`).get(messageId, userId, kind);
  if (existing) db.prepare(`DELETE FROM reactions WHERE message_id=? AND user_id=? AND kind=?`).run(messageId, userId, kind);
  else {
    db.prepare(`INSERT INTO reactions (message_id, user_id, kind) VALUES (?,?,?)`).run(messageId, userId, kind);
    if (m.sender_id !== userId) {
      const who = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(userId)?.display_name || 'Someone';
      notify(m.sender_id, 'reaction', `${who} reacted to your message`,
        m.kind === 'sealed' ? 'Encrypted message' : (m.body || 'attachment').slice(0, 140),
        { conversationId: m.conversation_id, messageId, reaction: kind });
    }
  }
  mirror.reactions(messageId);
  return { conversationId: m.conversation_id, reactions: reactionsFor([messageId], userId)[messageId] || [] };
}

export function editMessage(messageId, userId, newBody) {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m || m.deleted) throw Object.assign(new Error('Message not found.'), { status: 404 });
  if (m.sender_id !== userId) throw Object.assign(new Error('You can only edit your own messages.'), { status: 403 });
  if (m.kind === 'sealed') throw Object.assign(new Error('Sealed messages cannot be edited.'), { status: 400 });
  if (m.kind === 'poll') throw Object.assign(new Error('Polls cannot be edited.'), { status: 400 });
  // Time capsules stay sealed against edits too — editing must never unseal one early
  if (m.unlock_at && m.unlock_at > Date.now()) throw Object.assign(new Error('A sealed time capsule cannot be edited until it opens.'), { status: 400 });
  const text = String(newBody || '').trim();
  if (!text) throw Object.assign(new Error('Empty message.'), { status: 400 });
  if (text.length > 8000) throw Object.assign(new Error('Message too long.'), { status: 400 });
  // The brain re-reads the edit for priority + freshly-detected signals, but we
  // PRESERVE the sender-attached signals (mood, forwarded, silent, capsule) so a
  // typo fix never silently strips context the user chose.
  const priority = classifyPriority(text);
  const KEEP = new Set(['mood', 'fwd', 'silent', 'capsule', 'poll']);
  const kept = (JSON.parse(m.signals || '[]')).filter(s => KEEP.has(s.type));
  const signals = [...kept, ...detectSignals(text)];
  db.prepare(`UPDATE messages SET body=?, priority=?, signals=?, edited_at=? WHERE id=?`)
    .run(text, priority, JSON.stringify(signals), now(), messageId);
  db.prepare(`DELETE FROM fts WHERE kind='message' AND ref_id=?`).run(String(messageId));
  ftsIndex('message', messageId, m.conversation_id, text);
  mirror.message(messageId);
  return rowToMessage(db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId));
}

/** Poll vote aggregation for a set of messages → { [id]: {counts, total, mine} } */
export function pollVotesFor(messageIds, viewerId) {
  if (!messageIds.length) return {};
  const ph = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT message_id, user_id, opt FROM poll_votes WHERE message_id IN (${ph})`).all(...messageIds);
  const out = {};
  for (const r of rows) {
    const v = (out[r.message_id] ||= { counts: {}, total: 0, mine: null });
    v.counts[r.opt] = (v.counts[r.opt] || 0) + 1;
    v.total++;
    if (r.user_id === viewerId) v.mine = r.opt;
  }
  return out;
}

export function votePoll(messageId, userId, opt) {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m || m.deleted || m.kind !== 'poll') throw Object.assign(new Error('Poll not found.'), { status: 404 });
  const options = JSON.parse(m.signals).find(s => s.type === 'poll')?.options || [];
  const idx = Number(opt);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) throw Object.assign(new Error('Not an option.'), { status: 400 });
  db.prepare(`INSERT OR REPLACE INTO poll_votes (message_id, user_id, opt) VALUES (?,?,?)`).run(messageId, userId, idx);
  mirror.votes(messageId);
  return { conversationId: m.conversation_id, votes: pollVotesFor([messageId], userId)[messageId] };
}

const DAY_MS = 86_400_000;

/** Chat streak: consecutive days BOTH sides showed up. Alive if it includes
    today or yesterday (today's message hasn't happened yet ≠ streak broken). */
export function chatStreak(conversationId, aId, bId) {
  const rows = db.prepare(`
    SELECT sender_id, created_at FROM messages
    WHERE conversation_id=? AND deleted=0 AND created_at > ?
  `).all(conversationId, Date.now() - 90 * DAY_MS);
  const days = new Map(); // dayKey -> Set(senders)
  for (const r of rows) {
    const key = Math.floor((r.created_at + new Date().getTimezoneOffset() * -60000) / DAY_MS);
    (days.get(key) || days.set(key, new Set()).get(key)).add(r.sender_id);
  }
  const both = key => days.get(key)?.has(aId) && days.get(key)?.has(bId);
  const today = Math.floor((Date.now() + new Date().getTimezoneOffset() * -60000) / DAY_MS);
  let start = both(today) ? today : both(today - 1) ? today - 1 : null;
  if (start === null) return 0;
  let streak = 0;
  while (both(start - streak)) streak++;
  return streak;
}

/** Vibe Check Streak: consecutive days BOTH sides dropped a voice note or a
    video — dry text keeps the chat streak alive, but not this one. Same
    today-or-yesterday alive rule as chatStreak. */
export function vibeStreak(conversationId, aId, bId) {
  const rows = db.prepare(`
    SELECT sender_id, created_at, attachment FROM messages
    WHERE conversation_id=? AND deleted=0 AND attachment IS NOT NULL AND created_at > ?
  `).all(conversationId, Date.now() - 90 * DAY_MS);
  const days = new Map(); // dayKey -> Set(senders who sent voice/video)
  for (const r of rows) {
    let type = '';
    try { type = JSON.parse(r.attachment)?.type || ''; } catch { }
    if (!type.startsWith('audio/') && !type.startsWith('video/')) continue;
    const key = Math.floor((r.created_at + new Date().getTimezoneOffset() * -60000) / DAY_MS);
    (days.get(key) || days.set(key, new Set()).get(key)).add(r.sender_id);
  }
  const both = key => days.get(key)?.has(aId) && days.get(key)?.has(bId);
  const today = Math.floor((Date.now() + new Date().getTimezoneOffset() * -60000) / DAY_MS);
  let start = both(today) ? today : both(today - 1) ? today - 1 : null;
  if (start === null) return 0;
  let streak = 0;
  while (both(start - streak)) streak++;
  return streak;
}

export function deleteMessage(messageId, userId) {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m || m.deleted) throw Object.assign(new Error('Message not found.'), { status: 404 });
  if (m.sender_id !== userId) throw Object.assign(new Error('You can only remove your own messages.'), { status: 403 });
  db.prepare(`UPDATE messages SET body='', attachment=NULL, deleted=1, signals='[]' WHERE id=?`).run(messageId);
  db.prepare(`DELETE FROM fts WHERE kind='message' AND ref_id=?`).run(String(messageId));
  db.prepare(`DELETE FROM reactions WHERE message_id=?`).run(messageId);
  mirror.message(messageId);
  mirror.reactions(messageId);
  return { conversationId: m.conversation_id };
}

/** Preview text safe to show in lists/briefings — never leak sealed bodies. */
export function previewBody(row) {
  if (row.kind === 'sealed') return 'Encrypted message';
  if (row.unlock_at && row.unlock_at > Date.now()) return 'A sealed time capsule';
  if (!row.body) {
    try {
      const sigs = JSON.parse(row.signals || '[]');
      if (sigs.some(s => s.type === 'viewonce')) return '📷 Photo';
      if (sigs.some(s => s.type === 'location')) return '📍 Location';
    } catch { /* ignore */ }
    if (row.attachment) return (JSON.parse(row.attachment).name || 'attachment');
  }
  return row.body;
}

/** Time Capsules stay dark for EVERYONE (sender included) until they unlock. */
export function maskCapsule(m) {
  if (m.unlock_at && m.unlock_at > Date.now()) {
    return { ...m, body: '', attachment: null, signals: [{ type: 'capsule', at: m.unlock_at }], locked: true };
  }
  return m;
}

/**
 * View-once photos never ship their URL inside message payloads — the client
 * fetches the image exactly once through openViewOnce(). The signal carries the
 * opened/expired state so the bubble can render "Tap to view" / "Opened".
 */
export function maskViewOnce(m) {
  const sig = (m.signals || []).find(s => s.type === 'viewonce');
  if (!sig) return m;
  return { ...m, attachment: null };
}

/**
 * Consume a view-once photo. Only the recipient may open it, exactly once; the
 * attachment is then wiped from the row so it can never be replayed or survive
 * a reload. Returns the one-time URL for immediate display.
 */
export function openViewOnce(messageId, viewerId) {
  const row = db.prepare(`SELECT * FROM messages WHERE id=? AND deleted=0`).get(Number(messageId));
  if (!row) throw Object.assign(new Error('Photo not found.'), { status: 404 });
  const signals = JSON.parse(row.signals || '[]');
  const sig = signals.find(s => s.type === 'viewonce');
  if (!sig) throw Object.assign(new Error('Not a view-once photo.'), { status: 400 });
  if (viewerId === row.sender_id) throw Object.assign(new Error('You can\'t replay your own view-once photo.'), { status: 403 });
  if (sig.opened) throw Object.assign(new Error('This photo has already been viewed.'), { status: 410 });
  const att = row.attachment ? JSON.parse(row.attachment) : null;
  if (!att) throw Object.assign(new Error('This photo is no longer available.'), { status: 410 });

  db.prepare(`INSERT OR IGNORE INTO message_views (message_id, user_id, viewed_at) VALUES (?,?,?)`).run(row.id, viewerId, now());
  sig.opened = true; sig.viewedAt = now();
  db.prepare(`UPDATE messages SET attachment=NULL, signals=? WHERE id=?`).run(JSON.stringify(signals), row.id);
  mirror.message(row.id);
  return { conversationId: row.conversation_id, url: att.url, name: att.name, type: att.type };
}

export function addTimelineEvent(userId, otherId, type, title) {
  const stmt = db.prepare(`INSERT INTO timeline_events (user_id, other_id, type, title, created_at) VALUES (?,?,?,?,?)`);
  // Mirror the event onto both sides of the relationship
  stmt.run(userId, otherId, type, title, now());
  stmt.run(otherId, userId, type, title, now());
}

export function markRead(conversationId, userId) {
  const last = db.prepare(`SELECT MAX(id) AS m FROM messages WHERE conversation_id=?`).get(conversationId).m || 0;
  db.prepare(`
    INSERT INTO reads (conversation_id, user_id, last_read_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id
  `).run(conversationId, userId, last);
  mirror.read(conversationId, userId);
  return last;
}

/** Context Engine visibility: may `viewerId` see `target`'s live context? */
export function visibleContext(target, viewerId) {
  if (target.id === viewerId) return { context: target.context, context_note: target.context_note };
  if (target.context_scope === 'none') return { context: null, context_note: '' };
  if (target.context_scope === 'inner') {
    const rel = getRelationship(target.id, viewerId);
    if (!rel || rel.closeness !== 1) return { context: null, context_note: '' };
  }
  return { context: target.context, context_note: target.context_note };
}
