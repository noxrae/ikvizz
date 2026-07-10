// ============================================================================
// Ikvizz — REST API. Everything the SPA needs; sockets handle live events.
// ============================================================================
import { Router } from 'express';
import { db, now, getOrCreateDm, userCanAccessConversation, ftsIndex, ftsQuery } from './db.js';
import { createUser, verifyLogin, issueToken, authMiddleware, publicUser, httpErr, normalizePhone, setSessionCookie, clearSessionCookie } from './auth.js';
import { buildBriefing, CONTEXTS } from './brain.js';
import { sendMessage, rowToMessage, markRead, visibleContext, getRelationship, addTimelineEvent, previewBody, reactionsFor, replyPreviewFor, chatStreak, vibeStreak, maskCapsule, maskViewOnce, MOOD_TAGS, pollVotesFor } from './core.js';
import { isOnline } from './sockets.js';
import { summarizeConversation, ollamaModel } from './ai.js';
import { worlds as worldsRouter } from './worlds.js';
import { vibes as vibesRouter, syncMood, sweepMoodRooms } from './vibes.js';
import { chaos as chaosRouter } from './chaos.js';
import { GOOGLE_CLIENT_ID, verifyGoogleToken, userForGoogle } from './google.js';
import { normalizeAvatar } from '../public/js/avatar.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_ENABLED, verifySupabaseToken, userForSupabase } from './supabase.js';
import { mirror } from './cloud.js';
import { notify } from './notify.js';
import { vapidPublicKey } from './push.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const api = Router();

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' }); }
};

// Tiny dependency-free sliding-window rate limiter (per IP+bucket). Enough to
// stop credential stuffing and abusive floods without any external service.
const rlHits = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of rlHits) if (v.reset < t) rlHits.delete(k); }, 60_000).unref?.();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').toString().split(',')[0].trim();
    const key = bucket + ':' + ip;
    const now = Date.now();
    let e = rlHits.get(key);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; rlHits.set(key, e); }
    if (++e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts — take a breather and try again shortly.' });
    }
    next();
  };
}

// ---------------------------------------------------------------- auth -----
const issueSession = (res, user) => { const token = issueToken(user); setSessionCookie(res, token); return token; };

api.post('/auth/register', rateLimit('register', 10, 60 * 60_000), wrap((req, res) => {
  const user = createUser(req.body || {}); // accepts optional `phone` for discovery
  res.json({ token: issueSession(res, user), user: publicUser(user) });
}));

api.post('/auth/login', rateLimit('login', 30, 15 * 60_000), wrap((req, res) => {
  const user = verifyLogin(req.body?.username, req.body?.password);
  res.json({ token: issueSession(res, user), user: publicUser(user) });
}));

api.post('/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

// Public config: tells the client which identity providers are available
// (the anon/publishable key is designed to be public — RLS does the guarding)
api.get('/auth/config', (_req, res) => res.json({
  googleClientId: GOOGLE_CLIENT_ID,
  supabase: SUPABASE_ENABLED ? { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } : null,
}));

api.post('/auth/google', async (req, res) => {
  try {
    const payload = await verifyGoogleToken(req.body?.credential);
    const user = userForGoogle(payload);
    res.json({ token: issueSession(res, user), user: publicUser(user) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Supabase Auth (Milestone 3): the client signs in against Supabase directly,
// then exchanges the Supabase access token for a local Ikvizz session here.
api.post('/auth/supabase', async (req, res) => {
  try {
    const payload = await verifySupabaseToken(req.body?.accessToken);
    const user = userForSupabase(payload);
    res.json({ token: issueSession(res, user), user: publicUser(user) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

api.use(authMiddleware);

// The three worlds (EDU · LIFE · HORIZON) share the same core + auth
api.use(worldsRouter);

// The vibes layer: MoodSync Rooms · Roast My Life · Vibe Replay · Rizz Battle
api.use(vibesRouter);

// The chaos layer: Late Night Confession Train · Music Sync
api.use(chaosRouter);

const me = req => db.prepare(`SELECT * FROM users WHERE id=?`).get(req.userId);

api.get('/me', wrap((req, res) => {
  const user = me(req);
  setSessionCookie(res, issueToken(user)); // (re)establish the /files cookie for any live session
  const personas = db.prepare(`SELECT * FROM personas WHERE user_id=?`).all(req.userId);
  res.json({ user: { ...publicUser(user), phone: user.phone || null }, personas, contexts: CONTEXTS });
}));

// Context Engine: set my live context + who may see it
api.patch('/me/context', wrap((req, res) => {
  const { context, note, scope } = req.body || {};
  if (context && !CONTEXTS.some(c => c.key === context)) throw httpErr(400, 'Unknown context.');
  if (scope && !['all', 'inner', 'none'].includes(scope)) throw httpErr(400, 'Unknown scope.');
  const u = me(req);
  db.prepare(`UPDATE users SET context=?, context_note=?, context_scope=? WHERE id=?`)
    .run(context || u.context, note ?? u.context_note, scope || u.context_scope, req.userId);
  res.json({ user: publicUser(me(req)) });
}));

api.patch('/me', wrap((req, res) => {
  const { displayName, avatarUrl } = req.body || {};
  if (displayName?.trim()) db.prepare(`UPDATE users SET display_name=? WHERE id=?`).run(displayName.trim(), req.userId);
  if (avatarUrl !== undefined) {
    const u = String(avatarUrl || '');
    const okUrl = u === '' || (u.startsWith('/files/') && !u.includes('..')) || /^https:\/\/[a-z0-9.-]*googleusercontent\.com\//.test(u);
    if (!okUrl) throw httpErr(400, 'Profile photos must be uploaded here.');
    db.prepare(`UPDATE users SET avatar_url=? WHERE id=?`).run(u || null, req.userId);
  }
  res.json({ user: publicUser(me(req)) });
}));

// Avatar creator: save my layered-SVG choices (clamped to valid indices — the
// server never trusts raw SVG, only a config of integers it re-validates).
api.patch('/me/avatar', wrap((req, res) => {
  if (req.body?.config === null) { // explicit clear → back to the pastel initial
    db.prepare(`UPDATE users SET avatar_config=NULL WHERE id=?`).run(req.userId);
    return res.json({ user: publicUser(me(req)) });
  }
  const clean = normalizeAvatar(req.body?.config);
  db.prepare(`UPDATE users SET avatar_config=?, avatar_url=NULL WHERE id=?`).run(JSON.stringify(clean), req.userId);
  res.json({ user: publicUser(me(req)) });
}));

// Mood Canvas: your current Ikvizz mood blob (public expression, unlike context)
api.patch('/me/mood', wrap((req, res) => {
  const mood = req.body?.mood;
  if (mood !== null && mood !== '' && !MOOD_TAGS.includes(mood)) throw httpErr(400, 'Unknown mood.');
  db.prepare(`UPDATE users SET mood=? WHERE id=?`).run(mood || null, req.userId);
  // MoodSync Rooms: same mood right now → same temporary space
  const moodsync = mood ? syncMood(req.userId, mood) : null;
  res.json({ user: publicUser(me(req)), moodsync });
}));

// ------------------------------------------------------------ personas -----
api.post('/personas', wrap((req, res) => {
  const { name, emoji, bio } = req.body || {};
  if (!name?.trim()) throw httpErr(400, 'Persona needs a name.');
  const r = db.prepare(`INSERT INTO personas (user_id, name, emoji, bio, created_at) VALUES (?,?,?,?,?)`)
    .run(req.userId, name.trim(), emoji || '🌐', bio || '', now());
  res.json(db.prepare(`SELECT * FROM personas WHERE id=?`).get(r.lastInsertRowid));
}));

api.patch('/personas/:id', wrap((req, res) => {
  const p = db.prepare(`SELECT * FROM personas WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!p) throw httpErr(404, 'Persona not found.');
  const { name, emoji, bio } = req.body || {};
  db.prepare(`UPDATE personas SET name=?, emoji=?, bio=? WHERE id=?`)
    .run(name?.trim() || p.name, emoji || p.emoji, bio ?? p.bio, p.id);
  res.json(db.prepare(`SELECT * FROM personas WHERE id=?`).get(p.id));
}));

// -------------------------------------------------- relationship graph -----
const REL_KINDS = ['Friend', 'Close Friend', 'Family', 'Partner', 'Manager', 'Colleague', 'Mentor', 'Student', 'Doctor', 'Investor', 'Client'];

api.get('/people', wrap((req, res) => {
  const rels = db.prepare(`
    SELECT r.*, u.username, u.display_name, u.avatar_hue, u.avatar_url, u.avatar_config, u.context, u.context_note, u.context_scope, u.mood, u.rizz_king_until,
           p.name AS persona_name, p.emoji AS persona_emoji
    FROM relationships r
    JOIN users u ON u.id = r.other_id
    LEFT JOIN personas p ON p.id = r.persona_id
    WHERE r.user_id = ?
  `).all(req.userId);

  const people = rels.map(r => {
    const convo = getOrCreateDm(req.userId, r.other_id);
    const last = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(convo.id);
    const lastRead = db.prepare(`SELECT last_read_id FROM reads WHERE conversation_id=? AND user_id=?`)
      .get(convo.id, req.userId)?.last_read_id || 0;
    const unread = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=? AND id>? AND sender_id!=?`)
      .get(convo.id, lastRead, req.userId).c;
    const msgCount = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=?`).get(convo.id).c;
    const ctx = visibleContext({ id: r.other_id, context: r.context, context_note: r.context_note, context_scope: r.context_scope }, req.userId);
    return {
      relationship_id: r.id, other_id: r.other_id, username: r.username,
      display_name: r.display_name, avatar_hue: r.avatar_hue, avatar_url: r.avatar_url || null, avatar_config: r.avatar_config || null,
      kind: r.kind, closeness: r.closeness, persona_id: r.persona_id, mood: r.mood || null,
      rizz_king: (r.rizz_king_until || 0) > Date.now(), // Rizz Battle: the 24h crown
      pinned: !!r.pinned, muted: !!r.muted,
      persona: r.persona_name ? { name: r.persona_name, emoji: r.persona_emoji } : null,
      context: ctx.context, context_note: ctx.context_note, online: isOnline(r.other_id),
      conversation_id: convo.id, unread, message_count: msgCount,
      streak: chatStreak(convo.id, req.userId, r.other_id),
      vibe_streak: vibeStreak(convo.id, req.userId, r.other_id), // Vibe Check: voice/video days only
      last_message: last ? { body: previewBody(last), created_at: last.created_at, priority: last.priority, mine: last.sender_id === req.userId } : null,
    };
  });
  res.json({ people, kinds: REL_KINDS });
}));

api.post('/people', wrap((req, res) => {
  const { username, kind, closeness } = req.body || {};
  // Find by @username (Instagram-style) OR phone number (WhatsApp-style)
  const handle = String(username || '').trim().toLowerCase();
  const phone = normalizePhone(handle);
  const other = phone
    ? db.prepare(`SELECT * FROM users WHERE phone=?`).get(phone)
    : db.prepare(`SELECT * FROM users WHERE username=?`).get(handle);
  if (!other) throw httpErr(404, phone ? 'No one with that number here yet — send them your invite link.' : 'No one with that username yet.');
  if (other.id === req.userId) throw httpErr(400, 'That is you. Ikvizz already remembers you.');
  const existing = db.prepare(`SELECT id FROM relationships WHERE user_id=? AND other_id=?`).get(req.userId, other.id);
  if (existing) throw httpErr(409, 'Already in your relationship graph.');
  db.prepare(`INSERT INTO relationships (user_id, other_id, kind, closeness, created_at) VALUES (?,?,?,?,?)`)
    .run(req.userId, other.id, REL_KINDS.includes(kind) ? kind : 'Friend', [1, 2, 3].includes(closeness) ? closeness : 2, now());
  // Reciprocal edge (they can retype it on their side)
  const back = db.prepare(`SELECT id FROM relationships WHERE user_id=? AND other_id=?`).get(other.id, req.userId);
  if (!back) db.prepare(`INSERT INTO relationships (user_id, other_id, kind, closeness, created_at) VALUES (?,?,?,?,?)`)
    .run(other.id, req.userId, 'Friend', 2, now());
  getOrCreateDm(req.userId, other.id);
  res.json({ ok: true });
}));

api.patch('/people/:relId', wrap((req, res) => {
  const rel = db.prepare(`SELECT * FROM relationships WHERE id=? AND user_id=?`).get(req.params.relId, req.userId);
  if (!rel) throw httpErr(404, 'Relationship not found.');
  const { kind, closeness, personaId, pinned, muted } = req.body || {};
  db.prepare(`UPDATE relationships SET kind=?, closeness=?, persona_id=?, pinned=?, muted=? WHERE id=?`).run(
    REL_KINDS.includes(kind) ? kind : rel.kind,
    [1, 2, 3].includes(closeness) ? closeness : rel.closeness,
    personaId !== undefined ? personaId : rel.persona_id,
    pinned !== undefined ? (pinned ? 1 : 0) : rel.pinned,
    muted !== undefined ? (muted ? 1 : 0) : rel.muted,
    rel.id,
  );
  res.json({ ok: true });
}));

// ------------------------------------------------------------ moments -----
// Stories, the Ikvizz way: 24 hours, scoped (everyone / inner circle), then gone.
const STORY_TTL = 24 * 3600_000;

api.get('/stories', wrap((req, res) => {
  db.prepare(`DELETE FROM stories WHERE expires_at < ?`).run(Date.now()); // lazy expiry
  const rels = db.prepare(`SELECT other_id, closeness FROM relationships WHERE user_id=?`).all(req.userId);
  const visibleFrom = new Set([req.userId]);
  for (const r of rels) {
    // Their scope decides: 'inner' moments show only if THEY placed me in their inner circle
    const theirRel = getRelationship(r.other_id, req.userId);
    if (theirRel) visibleFrom.add(r.other_id);
  }
  const rows = db.prepare(`
    SELECT s.*, u.display_name, u.avatar_hue, u.avatar_url,
           (SELECT COUNT(*) FROM story_views WHERE story_id=s.id) AS views,
           EXISTS(SELECT 1 FROM story_views WHERE story_id=s.id AND user_id=?) AS seen
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.expires_at > ? ORDER BY s.created_at ASC
  `).all(req.userId, Date.now())
    .filter(s => {
      if (s.user_id === req.userId) return true;
      if (!visibleFrom.has(s.user_id)) return false;
      if (s.scope === 'inner') {
        const theirRel = getRelationship(s.user_id, req.userId);
        return theirRel?.closeness === 1;
      }
      return true;
    })
    .map(s => ({ ...s, attachment: s.attachment ? JSON.parse(s.attachment) : null, seen: !!s.seen, views: s.user_id === req.userId ? s.views : undefined }));

  // Group per person: you first, then people with unseen moments
  const byUser = new Map();
  for (const s of rows) {
    const g = byUser.get(s.user_id) || { user_id: s.user_id, display_name: s.display_name, avatar_hue: s.avatar_hue, avatar_url: s.avatar_url, stories: [] };
    g.stories.push(s);
    byUser.set(s.user_id, g);
  }
  const groups = [...byUser.values()].map(g => ({ ...g, allSeen: g.stories.every(s => s.seen || s.user_id === req.userId) }));
  groups.sort((a, b) => (a.user_id === req.userId ? -1 : b.user_id === req.userId ? 1 : a.allSeen - b.allSeen));
  res.json({ groups, me: req.userId });
}));

api.post('/stories', wrap((req, res) => {
  const { kind, body, attachment, scope } = req.body || {};
  // Phase 8: moments come in five voices — text, photo, video, voice, music
  const k = ['text', 'image', 'video', 'voice', 'music'].includes(kind) ? kind : 'text';
  const text = String(body || '').trim().slice(0, 500);
  if (k === 'text' && !text) throw httpErr(400, 'Say something.');
  let att = null;
  if (k !== 'text') {
    if (!attachment?.url?.startsWith('/files/')) throw httpErr(400, 'Upload the media here first.');
    att = JSON.stringify({ url: attachment.url, name: String(attachment.name || ''), type: String(attachment.type || '') });
  }
  const r = db.prepare(`INSERT INTO stories (user_id, kind, body, attachment, scope, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(req.userId, k, text, att, scope === 'inner' ? 'inner' : 'all', now(), now() + STORY_TTL);
  mirror.story(Number(r.lastInsertRowid));

  // Tell the people it's actually FOR (respecting scope) — quietly, in the center
  const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(req.userId);
  const circle = db.prepare(`SELECT other_id, closeness FROM relationships WHERE user_id=?`).all(req.userId)
    .filter(rel => scope !== 'inner' || rel.closeness === 1);
  for (const rel of circle) {
    notify(rel.other_id, 'story', `${me.display_name} dropped a moment`, text.slice(0, 100) || `a ${k} moment`, { userId: req.userId });
  }
  res.json(db.prepare(`SELECT * FROM stories WHERE id=?`).get(r.lastInsertRowid));
}));

api.post('/stories/:id/view', wrap((req, res) => {
  const s = db.prepare(`SELECT * FROM stories WHERE id=? AND expires_at > ?`).get(req.params.id, Date.now());
  if (!s) throw httpErr(404, 'That moment has passed.');
  if (s.user_id !== req.userId) {
    db.prepare(`INSERT OR IGNORE INTO story_views (story_id, user_id, at) VALUES (?,?,?)`).run(s.id, req.userId, now());
    mirror.story(s.id);
  }
  res.json({ ok: true });
}));

api.delete('/stories/:id', wrap((req, res) => {
  const cloudId = db.prepare(`SELECT cloud_id FROM stories WHERE id=? AND user_id=?`).get(req.params.id, req.userId)?.cloud_id;
  db.prepare(`DELETE FROM stories WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  mirror.storyDelete(cloudId);
  res.json({ ok: true });
}));

// --------------------------------------------------- future reminders -----
// "Next time I talk to Sarah, bring up the internship." Surfaces when you
// open that chat — the reminder is attached to the PERSON, not a clock.
api.get('/people/:otherId/reminders', wrap((req, res) => {
  const reminders = db.prepare(`SELECT * FROM reminders WHERE user_id=? AND other_id=? AND status='open' ORDER BY created_at ASC`)
    .all(req.userId, Number(req.params.otherId));
  res.json({ reminders });
}));

api.post('/people/:otherId/reminders', wrap((req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) throw httpErr(400, 'What should I bring up?');
  if (!getRelationship(req.userId, Number(req.params.otherId))) throw httpErr(404, 'Not in your universe.');
  const r = db.prepare(`INSERT INTO reminders (user_id, other_id, body, created_at) VALUES (?,?,?,?)`)
    .run(req.userId, Number(req.params.otherId), body.slice(0, 300), now());
  res.json(db.prepare(`SELECT * FROM reminders WHERE id=?`).get(r.lastInsertRowid));
}));

api.patch('/reminders/:id', wrap((req, res) => {
  db.prepare(`UPDATE reminders SET status='done' WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// -------------------------------------------------- Friendship Wrapped -----
// Spotify-Wrapped energy for a relationship: receipts, lovingly presented.
const STOPWORDS = new Set('the a an and or but so to of in on at for with is are was were be been i you we they he she it this that my your our me him her them will would can could just not no yes ok okay do did done have has had what when where how why who'.split(' '));

api.get('/people/:otherId/wrapped', wrap((req, res) => {
  const otherId = Number(req.params.otherId);
  const other = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(otherId);
  if (!other || !getRelationship(req.userId, otherId)) throw httpErr(404, 'Not in your universe.');
  const convo = getOrCreateDm(req.userId, otherId);
  const msgs = db.prepare(`
    SELECT sender_id, body, created_at, kind FROM messages
    WHERE conversation_id=? AND deleted=0 ORDER BY id ASC
  `).all(convo.id);
  if (msgs.length < 2) return res.json({ tooEarly: true });

  const mine = msgs.filter(m => m.sender_id === req.userId);
  const theirs = msgs.filter(m => m.sender_id === otherId);

  // Who texts first: opener after a 6h+ silence
  let iOpened = 0, theyOpened = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (i === 0 || msgs[i].created_at - msgs[i - 1].created_at > 6 * 3600_000) {
      msgs[i].sender_id === req.userId ? iOpened++ : theyOpened++;
    }
  }

  // Reply speed: their first response after my message (within 24h), and vice versa
  const avgReply = (fromId) => {
    const gaps = [];
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].sender_id === fromId && msgs[i - 1].sender_id !== fromId) {
        const gap = msgs[i].created_at - msgs[i - 1].created_at;
        if (gap < 24 * 3600_000) gaps.push(gap);
      }
    }
    return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  };
  const ghostLabel = ms => ms === null ? 'jury is still out'
    : ms < 5 * 60_000 ? 'replies at the speed of light'
    : ms < 3600_000 ? 'pretty attached, honestly'
    : ms < 6 * 3600_000 ? 'healthy boundaries'
    : 'certified professional ghoster';

  // Peak hour + top word
  const hours = msgs.map(m => new Date(m.created_at).getHours());
  const peakHour = hours.sort((a, b) => hours.filter(h => h === b).length - hours.filter(h => h === a).length)[0];
  const freq = {};
  for (const m of msgs) {
    if (m.kind === 'sealed') continue;
    for (const w of m.body.toLowerCase().split(/[^a-z']+/)) {
      if (w.length > 2 && !STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    }
  }
  const topWord = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const streak = chatStreak(convo.id, req.userId, otherId);
  const vibe = vibeStreak(convo.id, req.userId, otherId);
  const memories = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE user_id=? AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)`).get(req.userId, convo.id).c;
  const promisesKept = db.prepare(`SELECT COUNT(*) AS c FROM promises WHERE status='kept' AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)`).get(convo.id).c;

  res.json({
    name: other.display_name,
    since: msgs[0].created_at,
    total: msgs.length, mine: mine.length, theirs: theirs.length,
    streak, vibeStreak: vibe, iOpened, theyOpened,
    myReplyMs: avgReply(req.userId), theirReplyMs: avgReply(otherId),
    myGhost: ghostLabel(avgReply(req.userId)), theirGhost: ghostLabel(avgReply(otherId)),
    peakHour, topWord, memories, promisesKept,
  });
}));

api.get('/people/:otherId/timeline', wrap((req, res) => {
  const events = db.prepare(`
    SELECT * FROM timeline_events WHERE user_id=? AND other_id=? ORDER BY created_at DESC LIMIT 50
  `).all(req.userId, Number(req.params.otherId));
  res.json({ events });
}));

// The persona of THEM I'm allowed to see = the persona they assigned to me
api.get('/people/:otherId/profile', wrap((req, res) => {
  const other = db.prepare(`SELECT * FROM users WHERE id=?`).get(Number(req.params.otherId));
  if (!other) throw httpErr(404, 'Not found.');
  const theirRelToMe = getRelationship(other.id, req.userId);
  const persona = theirRelToMe?.persona_id
    ? db.prepare(`SELECT name, emoji, bio FROM personas WHERE id=?`).get(theirRelToMe.persona_id)
    : null;
  const ctx = visibleContext(other, req.userId);
  res.json({ user: { ...publicUser(other), ...ctx }, persona, public_key: other.public_key || null });
}));

api.get('/users/search', wrap((req, res) => {
  // Require a real query so nobody can dump the whole directory with an empty search
  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) return res.json({ users: [] });
  const q = `%${raw}%`;
  const users = db.prepare(`
    SELECT id, username, display_name, avatar_hue, avatar_config FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 8
  `).all(q, q, req.userId);
  res.json({ users });
}));

// ------------------------------------------------------------ messages -----
function requireConversation(req) {
  const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(req.params.id));
  if (!convo || !userCanAccessConversation(req.userId, convo)) throw httpErr(404, 'Conversation not found.');
  return convo;
}

api.get('/conversations/:id/messages', wrap((req, res) => {
  const convo = requireConversation(req);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_hue, u.avatar_url, u.avatar_config
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 60
  `).all(convo.id, before).reverse();
  const ids = rows.map(r => r.id);
  const reactions = reactionsFor(ids, req.userId);
  const replies = replyPreviewFor(ids.filter(id => rows.find(r => r.id === id)?.reply_to));
  const pollVotes = pollVotesFor(rows.filter(r => r.kind === 'poll').map(r => r.id), req.userId);
  const messages = rows.map(r => ({
    ...maskViewOnce(maskCapsule(rowToMessage(r))),
    sender: { id: r.sender_id, username: r.username, display_name: r.display_name, avatar_hue: r.avatar_hue, avatar_url: r.avatar_url, avatar_config: r.avatar_config || null },
    reactions: reactions[r.id] || [],
    reply: replies[r.id] || null,
    votes: r.kind === 'poll' ? (pollVotes[r.id] || { counts: {}, total: 0, mine: null }) : undefined,
  }));
  // Where has the other side read up to? Powers the "Seen" indicator.
  const othersRead = db.prepare(`SELECT MIN(last_read_id) AS r FROM reads WHERE conversation_id=? AND user_id!=?`)
    .get(convo.id, req.userId)?.r || 0;
  const pinned = db.prepare(`SELECT message_id FROM pins WHERE conversation_id=?`).all(convo.id).map(p => p.message_id);
  res.json({ messages, conversation: convo, othersReadTo: othersRead, pinned });
}));

api.post('/conversations/:id/messages', wrap((req, res) => {
  const convo = requireConversation(req);
  const msg = sendMessage({
    conversationId: convo.id, senderId: req.userId, body: req.body?.body,
    replyTo: req.body?.replyTo || null, kind: req.body?.kind || 'text', attachment: req.body?.attachment || null,
    silent: !!req.body?.silent, unlockAt: req.body?.unlockAt || null, mood: req.body?.mood || null,
    forwarded: !!req.body?.forwarded, pollOptions: req.body?.pollOptions || null,
    effect: req.body?.effect || null, location: req.body?.location || null,
    viewOnce: !!req.body?.viewOnce,
  });
  res.json({ message: maskViewOnce(msg) });
}));

api.post('/conversations/:id/read', wrap((req, res) => {
  const convo = requireConversation(req);
  res.json({ lastReadId: markRead(convo.id, req.userId) });
}));

// ----------------------------------- pinned messages & shared files (Phase 6)
const spaceRole = (spaceId, userId) =>
  db.prepare(`SELECT role FROM space_members WHERE space_id=? AND user_id=?`).get(spaceId, userId)?.role || null;

api.post('/messages/:id/pin', wrap((req, res) => {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(req.params.id));
  if (!m || m.deleted) throw httpErr(404, 'Message not found.');
  const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(m.conversation_id);
  if (!convo || !userCanAccessConversation(req.userId, convo)) throw httpErr(404, 'Message not found.');
  // In spaces, pinning is a steering wheel — owner & admins only. DMs: both of you.
  if (convo.kind === 'space' && !['owner', 'admin'].includes(spaceRole(convo.space_id, req.userId))) {
    throw httpErr(403, 'Only the space owner or admins can pin here.');
  }
  const existing = db.prepare(`SELECT 1 FROM pins WHERE conversation_id=? AND message_id=?`).get(convo.id, m.id);
  if (existing) db.prepare(`DELETE FROM pins WHERE conversation_id=? AND message_id=?`).run(convo.id, m.id);
  else {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM pins WHERE conversation_id=?`).get(convo.id).c;
    if (count >= 10) throw httpErr(400, 'Ten pins max — unpin something first.');
    db.prepare(`INSERT INTO pins (conversation_id, message_id, user_id, created_at) VALUES (?,?,?,?)`)
      .run(convo.id, m.id, req.userId, now());
  }
  res.json({ pinned: !existing });
}));

api.get('/conversations/:id/pins', wrap((req, res) => {
  const convo = requireConversation(req);
  const pins = db.prepare(`
    SELECT p.message_id, p.created_at AS pinned_at, m.body, m.kind, m.attachment, m.unlock_at,
           u.display_name AS sender_name, pu.display_name AS pinned_by
    FROM pins p JOIN messages m ON m.id = p.message_id
    JOIN users u ON u.id = m.sender_id JOIN users pu ON pu.id = p.user_id
    WHERE p.conversation_id=? ORDER BY p.created_at DESC
  `).all(convo.id).map(p => ({
    message_id: p.message_id, pinned_at: p.pinned_at, sender_name: p.sender_name,
    pinned_by: p.pinned_by, body: previewBody(p).slice(0, 140),
  }));
  res.json({ pins });
}));

api.get('/conversations/:id/files', wrap((req, res) => {
  const convo = requireConversation(req);
  const files = db.prepare(`
    SELECT m.id, m.attachment, m.created_at, u.display_name AS sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id=? AND m.attachment IS NOT NULL AND m.deleted=0
    ORDER BY m.id DESC LIMIT 200
  `).all(convo.id).map(f => ({ ...f, attachment: JSON.parse(f.attachment) }));
  res.json({ files });
}));

// -------------------------------------- notification center & push (Phase 9)
api.get('/notifications', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT id, kind, title, body, data, read, created_at FROM notifications
    WHERE user_id=? ORDER BY created_at DESC LIMIT 60
  `).all(req.userId).map(n => ({ ...n, data: JSON.parse(n.data || '{}'), read: !!n.read }));
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND read=0`).get(req.userId).c;
  res.json({ notifications: rows, unread });
}));

api.post('/notifications/read', wrap((req, res) => {
  const ids = db.prepare(`SELECT id FROM notifications WHERE user_id=? AND read=0`).all(req.userId);
  db.prepare(`UPDATE notifications SET read=1 WHERE user_id=?`).run(req.userId);
  for (const n of ids) mirror.notification(n.id); // read-state travels to the cloud too
  res.json({ ok: true });
}));

// Web Push (no Apple/APNs — see push.js): the browser brings a subscription,
// we keep it and use it only when you're away.
api.get('/push/key', (_req, res) => res.json({ key: vapidPublicKey() }));

api.post('/push/subscribe', wrap((req, res) => {
  const { endpoint, keys } = req.body?.subscription || req.body || {};
  if (!endpoint?.startsWith('https://') || !keys?.p256dh || !keys?.auth) throw httpErr(400, 'Not a Web Push subscription.');
  db.prepare(`
    INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth
  `).run(String(endpoint).slice(0, 1000), req.userId, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100), now());
  res.json({ ok: true });
}));

api.delete('/push/subscribe', wrap((req, res) => {
  db.prepare(`DELETE FROM push_subs WHERE user_id=? AND endpoint=?`).run(req.userId, String(req.body?.endpoint || ''));
  res.json({ ok: true });
}));

// ------------------------------------------------------------ AI summary -----
// "Catch me up" — local Ollama if available, transparent heuristic otherwise.
// Sealed (E2E) messages are excluded on principle: what humans encrypted, no AI reads.
api.get('/conversations/:id/summary', async (req, res) => {
  try {
    const convo = requireConversation(req);
    const rows = db.prepare(`
      SELECT m.*, u.display_name AS from_name FROM messages m JOIN users u ON u.id=m.sender_id
      WHERE m.conversation_id=? AND m.kind != 'sealed' ORDER BY m.id DESC LIMIT 100
    `).all(convo.id).reverse();
    const title = convo.kind === 'space'
      ? db.prepare(`SELECT name FROM spaces WHERE id=?`).get(convo.space_id)?.name || 'Space'
      : 'Conversation';
    const messages = rows.map(r => ({ from: r.from_name, body: r.body, priority: r.priority, signals: JSON.parse(r.signals || '[]'), created_at: r.created_at }));
    const result = await summarizeConversation(title, messages);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

api.get('/ai/status', async (_req, res) => {
  const model = await ollamaModel();
  res.json({ engine: model ? 'ollama:' + model : 'heuristic', local: true });
});

// --------------------------------------------------------------- uploads -----
// Media sharing: JSON+base64 keeps deps at zero. Files land in data/uploads
// with unguessable names and are served from /files.
// NOTE: svg/html/xml are deliberately excluded — they can carry inline script
// and would execute on our own origin (stealing the E2E key from localStorage).
const ALLOWED_EXT = /^(png|jpe?g|gif|webp|pdf|txt|md|csv|json|zip|mp3|m4a|ogg|wav|mp4|webm|mov|docx?|xlsx?|pptx?)$/i;
api.post('/upload', rateLimit('upload', 40, 5 * 60_000), wrap((req, res) => {
  const { name, type, dataBase64 } = req.body || {};
  if (!dataBase64) throw httpErr(400, 'No file data.');
  const buf = Buffer.from(String(dataBase64), 'base64');
  if (!buf.length) throw httpErr(400, 'Empty file.');
  if (buf.length > 8 * 1024 * 1024) throw httpErr(413, 'Max file size is 8 MB.');
  const ext = (String(name || '').split('.').pop() || 'bin').toLowerCase();
  if (!ALLOWED_EXT.test(ext)) throw httpErr(415, `File type .${ext} is not allowed.`);
  const fname = crypto.randomBytes(18).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  mirrorToSupabaseStorage(fname, buf, String(type || ''), req.userId); // cloud copy, non-blocking
  res.json({ url: '/files/' + fname, name: String(name || fname).slice(0, 200), type: String(type || '').slice(0, 100), size: buf.length });
}));

// Supabase Storage routing: every upload lands in the `media` bucket under the
// uploader's folder. Local disk stays authoritative; cloud is the durable copy.
async function mirrorToSupabaseStorage(fname, buf, mime, userId) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  if (!key || !base) return;
  const headers = { Authorization: `Bearer ${key}`, apikey: key };
  const put = () => fetch(`${base}/storage/v1/object/media/u${userId}/${fname}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }, body: buf,
  });
  try {
    let r = await put();
    if (!r.ok) { // bucket may not exist yet — create once, retry
      await fetch(`${base}/storage/v1/bucket`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'media', name: 'media', public: false }),
      });
      r = await put();
    }
    if (!r.ok) console.warn('[storage] mirror failed:', r.status, (await r.text()).slice(0, 120));
  } catch (e) { console.warn('[storage] mirror error:', e.message); }
}

// ------------------------------------------------------------- E2E keys -----
api.post('/me/pubkey', wrap((req, res) => {
  const key = String(req.body?.publicKey || '');
  if (key.length < 10 || key.length > 2000) throw httpErr(400, 'Bad key.');
  try { JSON.parse(key); } catch { throw httpErr(400, 'Key must be a JWK.'); }
  db.prepare(`UPDATE users SET public_key=? WHERE id=?`).run(key, req.userId);
  res.json({ ok: true });
}));

// ------------------------------------------------------- memory engine -----
api.post('/memories', wrap((req, res) => {
  const { messageId, body, note } = req.body || {};
  let text = String(body || '').trim();
  let mid = null;
  if (messageId) {
    const m = db.prepare(`SELECT m.*, c.a_id, c.b_id, c.space_id, c.kind FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`).get(messageId);
    if (!m) throw httpErr(404, 'Message not found.');
    const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(m.conversation_id);
    if (!userCanAccessConversation(req.userId, convo)) throw httpErr(403, 'Not your conversation.');
    text = m.body; mid = m.id;
    if (convo.kind === 'dm') {
      const otherId = convo.a_id === req.userId ? convo.b_id : convo.a_id;
      addTimelineEvent(req.userId, otherId, 'memory', text.slice(0, 120));
    }
  }
  if (!text) throw httpErr(400, 'Nothing to remember.');
  const r = db.prepare(`INSERT INTO memories (user_id, message_id, body, note, created_at) VALUES (?,?,?,?,?)`)
    .run(req.userId, mid, text, String(note || ''), now());
  ftsIndex('memory', r.lastInsertRowid, req.userId, text + ' ' + (note || ''));
  res.json(db.prepare(`SELECT * FROM memories WHERE id=?`).get(r.lastInsertRowid));
}));

api.get('/memories', wrap((req, res) => {
  res.json({ memories: db.prepare(`SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(req.userId) });
}));

api.delete('/memories/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM memories WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------ promises -----
api.get('/promises', wrap((req, res) => {
  const made = db.prepare(`
    SELECT p.*, u.display_name AS to_name FROM promises p LEFT JOIN users u ON u.id=p.to_id
    WHERE p.user_id=? ORDER BY p.status='open' DESC, p.created_at DESC LIMIT 50
  `).all(req.userId);
  const received = db.prepare(`
    SELECT p.*, u.display_name AS from_name FROM promises p JOIN users u ON u.id=p.user_id
    WHERE p.to_id=? ORDER BY p.status='open' DESC, p.created_at DESC LIMIT 50
  `).all(req.userId);
  res.json({ made, received });
}));

api.patch('/promises/:id', wrap((req, res) => {
  const p = db.prepare(`SELECT * FROM promises WHERE id=? AND (user_id=? OR to_id=?)`).get(req.params.id, req.userId, req.userId);
  if (!p) throw httpErr(404, 'Promise not found.');
  const status = ['open', 'kept', 'dropped'].includes(req.body?.status) ? req.body.status : p.status;
  db.prepare(`UPDATE promises SET status=? WHERE id=?`).run(status, p.id);
  res.json({ ok: true });
}));

// -------------------------------------------------------- living spaces -----
api.get('/spaces', wrap((req, res) => {
  sweepMoodRooms(); // lazy dissolve: expired MoodSync rooms become capsules now
  const spaces = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM space_members WHERE space_id=s.id) AS member_count,
           (SELECT COUNT(*) FROM space_items WHERE space_id=s.id AND type='task' AND status='open') AS open_tasks,
           (SELECT COUNT(*) FROM space_items WHERE space_id=s.id AND type='idea') AS ideas
    FROM spaces s JOIN space_members sm ON sm.space_id=s.id
    WHERE sm.user_id=? AND s.dissolved_at IS NULL
    ORDER BY s.created_at DESC
  `).all(req.userId);
  res.json({ spaces });
}));

api.post('/spaces', wrap((req, res) => {
  const { name, emoji, description, kind } = req.body || {};
  if (!name?.trim()) throw httpErr(400, 'A space needs a name.');
  const r = db.prepare(`INSERT INTO spaces (name, emoji, description, owner_id, created_at, kind) VALUES (?,?,?,?,?,?)`)
    .run(name.trim(), emoji || '🚀', description || '', req.userId, now(), kind === 'study' ? 'study' : 'general');
  const spaceId = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES (?,?,'owner')`).run(spaceId, req.userId);
  const convo = db.prepare(`INSERT INTO conversations (kind, space_id, created_at) VALUES ('space', ?, ?)`).run(spaceId, now());
  mirror.chat(Number(convo.lastInsertRowid));
  res.json(db.prepare(`SELECT * FROM spaces WHERE id=?`).get(spaceId));
}));

function requireSpace(req) {
  const space = db.prepare(`SELECT * FROM spaces WHERE id=?`).get(Number(req.params.id));
  const member = space && db.prepare(`SELECT 1 FROM space_members WHERE space_id=? AND user_id=?`).get(space.id, req.userId);
  if (!member) throw httpErr(404, 'Space not found.');
  return space;
}

api.get('/spaces/:id', wrap((req, res) => {
  const space = requireSpace(req);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_hue, u.avatar_url, sm.role
    FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE sm.space_id=?
  `).all(space.id);
  const items = db.prepare(`
    SELECT si.*, u.display_name AS creator_name FROM space_items si
    JOIN users u ON u.id=si.creator_id WHERE si.space_id=? ORDER BY si.created_at DESC
  `).all(space.id);
  const convo = db.prepare(`SELECT * FROM conversations WHERE kind='space' AND space_id=?`).get(space.id);
  res.json({ space, members, items, conversation_id: convo?.id });
}));

api.post('/spaces/:id/items', wrap((req, res) => {
  const space = requireSpace(req);
  const { type, title, body } = req.body || {};
  if (!['idea', 'task', 'decision', 'milestone', 'note', 'question'].includes(type)) throw httpErr(400, 'Unknown item type.');
  if (!title?.trim()) throw httpErr(400, 'Give it a title.');
  const r = db.prepare(`INSERT INTO space_items (space_id, type, title, body, creator_id, created_at) VALUES (?,?,?,?,?,?)`)
    .run(space.id, type, title.trim(), body || '', req.userId, now());
  ftsIndex('space_item', r.lastInsertRowid, space.id, `${title} ${body || ''}`);
  res.json(db.prepare(`SELECT * FROM space_items WHERE id=?`).get(r.lastInsertRowid));
}));

api.patch('/spaces/:id/items/:itemId', wrap((req, res) => {
  const space = requireSpace(req);
  const item = db.prepare(`SELECT * FROM space_items WHERE id=? AND space_id=?`).get(req.params.itemId, space.id);
  if (!item) throw httpErr(404, 'Item not found.');
  const status = ['open', 'done'].includes(req.body?.status) ? req.body.status : item.status;
  db.prepare(`UPDATE space_items SET status=? WHERE id=?`).run(status, item.id);
  res.json({ ok: true });
}));

// Phase 6 — admins & permissions: the owner steers, admins help, members talk.
api.post('/spaces/:id/members', wrap((req, res) => {
  const space = requireSpace(req);
  if (!['owner', 'admin'].includes(spaceRole(space.id, req.userId))) {
    throw httpErr(403, 'Only the owner or an admin can invite people here.');
  }
  const other = db.prepare(`SELECT id FROM users WHERE username=?`).get(String(req.body?.username || '').trim().toLowerCase());
  if (!other) throw httpErr(404, 'No such user.');
  db.prepare(`INSERT OR IGNORE INTO space_members (space_id, user_id) VALUES (?,?)`).run(space.id, other.id);
  const convo = db.prepare(`SELECT id FROM conversations WHERE kind='space' AND space_id=?`).get(space.id);
  if (convo) mirror.chat(convo.id); // membership changed → re-sync cloud chat_members
  res.json({ ok: true });
}));

api.patch('/spaces/:id/members/:userId', wrap((req, res) => {
  const space = requireSpace(req);
  if (spaceRole(space.id, req.userId) !== 'owner') throw httpErr(403, 'Only the owner hands out admin.');
  const targetId = Number(req.params.userId);
  if (targetId === space.owner_id) throw httpErr(400, 'The owner already steers this space.');
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  const r = db.prepare(`UPDATE space_members SET role=? WHERE space_id=? AND user_id=?`).run(role, space.id, targetId);
  if (!r.changes) throw httpErr(404, 'Not a member of this space.');
  res.json({ ok: true, role });
}));

api.delete('/spaces/:id/members/:userId', wrap((req, res) => {
  const space = requireSpace(req);
  const myRole = spaceRole(space.id, req.userId);
  const targetId = Number(req.params.userId);
  const targetRole = spaceRole(space.id, targetId);
  if (!targetRole) throw httpErr(404, 'Not a member of this space.');
  if (targetId === space.owner_id) throw httpErr(400, 'The owner cannot be removed.');
  const allowed = targetId === req.userId // anyone may leave
    || myRole === 'owner'
    || (myRole === 'admin' && targetRole === 'member');
  if (!allowed) throw httpErr(403, 'You cannot remove this member.');
  db.prepare(`DELETE FROM space_members WHERE space_id=? AND user_id=?`).run(space.id, targetId);
  const convo = db.prepare(`SELECT id FROM conversations WHERE kind='space' AND space_id=?`).get(space.id);
  if (convo) mirror.chat(convo.id);
  res.json({ ok: true });
}));

// -------------------------------------------------- export my universe -----
// Data ownership, for real: everything Ikvizz knows about you, one JSON.
api.get('/export', wrap((req, res) => {
  const uid = req.userId;
  const myDmConvos = db.prepare(`SELECT id FROM conversations WHERE kind='dm' AND (a_id=? OR b_id=?)`).all(uid, uid).map(c => c.id);
  const mySpaceIds = db.prepare(`SELECT space_id FROM space_members WHERE user_id=?`).all(uid).map(s => s.space_id);
  const spaceConvos = mySpaceIds.length
    ? db.prepare(`SELECT id FROM conversations WHERE kind='space' AND space_id IN (${mySpaceIds.map(() => '?').join(',')})`).all(...mySpaceIds).map(c => c.id)
    : [];
  const convoIds = [...myDmConvos, ...spaceConvos];
  const messages = convoIds.length
    ? db.prepare(`SELECT id, conversation_id, sender_id, body, priority, signals, reply_to, created_at, kind, attachment, edited_at, deleted, unlock_at
                  FROM messages WHERE conversation_id IN (${convoIds.map(() => '?').join(',')})`).all(...convoIds)
        .map(m => (m.unlock_at && m.unlock_at > Date.now()) ? { ...m, body: '[sealed time capsule]' } : m)
    : [];
  const user = db.prepare(`SELECT id, username, display_name, email, phone, mood, context, created_at FROM users WHERE id=?`).get(uid);
  res.setHeader('Content-Disposition', 'attachment; filename="aether-universe.json"');
  res.json({
    exported_at: new Date().toISOString(),
    note: 'Your entire Ikvizz universe. It was always yours — this just makes it portable.',
    user,
    personas: db.prepare(`SELECT * FROM personas WHERE user_id=?`).all(uid),
    relationships: db.prepare(`SELECT r.*, u.username AS other_username, u.display_name AS other_name FROM relationships r JOIN users u ON u.id=r.other_id WHERE r.user_id=?`).all(uid),
    messages,
    memories: db.prepare(`SELECT * FROM memories WHERE user_id=?`).all(uid),
    promises: db.prepare(`SELECT * FROM promises WHERE user_id=? OR to_id=?`).all(uid, uid),
    reminders: db.prepare(`SELECT * FROM reminders WHERE user_id=?`).all(uid),
    spaces: mySpaceIds.length ? db.prepare(`SELECT * FROM spaces WHERE id IN (${mySpaceIds.map(() => '?').join(',')})`).all(...mySpaceIds) : [],
    space_items: mySpaceIds.length ? db.prepare(`SELECT * FROM space_items WHERE space_id IN (${mySpaceIds.map(() => '?').join(',')})`).all(...mySpaceIds) : [],
    concepts: db.prepare(`SELECT * FROM concepts WHERE user_id=?`).all(uid),
    life_items: db.prepare(`SELECT * FROM life_items WHERE user_id=?`).all(uid),
    habits: db.prepare(`SELECT * FROM habits WHERE user_id=?`).all(uid),
    timeline: db.prepare(`SELECT * FROM timeline_events WHERE user_id=?`).all(uid),
  });
}));

// ------------------------------------------------------- daily briefing -----
api.get('/briefing', wrap((req, res) => res.json(buildBriefing(req.userId))));

// ----------------------------------------------------- universal search -----
// "Searches the entire relationship" — messages, memories, space items, people.
// Context Search (Phase 10): ?kind=message|memory|space_item narrows the lens,
// ?in=<conversationId> searches inside ONE conversation's history.
api.get('/search', wrap((req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const kindFilter = ['message', 'memory', 'space_item'].includes(req.query.kind) ? req.query.kind : null;
  const inConvo = Number(req.query.in) || null;

  let hits = db.prepare(`
    SELECT kind, ref_id, owner_hint, snippet(fts, 3, '⟪', '⟫', '…', 12) AS snip
    FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 80
  `).all(ftsQuery(q));
  if (kindFilter) hits = hits.filter(h => h.kind === kindFilter);
  if (inConvo) hits = hits.filter(h => h.kind === 'message' && Number(h.owner_hint) === inConvo);

  const results = [];
  for (const h of hits) {
    if (h.kind === 'message') {
      const m = db.prepare(`
        SELECT m.*, u.display_name AS sender_name, c.kind AS ckind, c.a_id, c.b_id, c.space_id
        FROM messages m JOIN users u ON u.id=m.sender_id JOIN conversations c ON c.id=m.conversation_id
        WHERE m.id=?
      `).get(Number(h.ref_id));
      if (!m) continue;
      const convo = { kind: m.ckind, a_id: m.a_id, b_id: m.b_id, space_id: m.space_id };
      const allowed = convo.kind === 'dm'
        ? (m.a_id === req.userId || m.b_id === req.userId)
        : !!db.prepare(`SELECT 1 FROM space_members WHERE space_id=? AND user_id=?`).get(m.space_id, req.userId);
      if (!allowed) continue;
      results.push({ kind: 'message', id: m.id, conversation_id: m.conversation_id, snippet: h.snip, from: m.sender_name, created_at: m.created_at });
    } else if (h.kind === 'memory') {
      if (Number(h.owner_hint) !== req.userId) continue;
      results.push({ kind: 'memory', id: Number(h.ref_id), snippet: h.snip });
    } else if (h.kind === 'space_item') {
      const member = db.prepare(`SELECT 1 FROM space_members WHERE space_id=? AND user_id=?`).get(Number(h.owner_hint), req.userId);
      if (!member) continue;
      const item = db.prepare(`SELECT * FROM space_items WHERE id=?`).get(Number(h.ref_id));
      if (item) results.push({ kind: 'space_item', id: item.id, space_id: item.space_id, type: item.type, snippet: h.snip });
    }
    if (results.length >= 20) break;
  }

  // People match too — search should feel omniscient (unless a lens is set)
  const people = (kindFilter || inConvo) ? [] : db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_hue, r.kind
    FROM relationships r JOIN users u ON u.id=r.other_id
    WHERE r.user_id=? AND (u.display_name LIKE ? OR u.username LIKE ?) LIMIT 5
  `).all(req.userId, `%${q}%`, `%${q}%`);

  res.json({ results, people });
}));
