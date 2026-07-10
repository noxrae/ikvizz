// ============================================================================
// IKVIZZ — Chaos layer: Late Night Confession Train + Music Sync.
// 100% free, local-first, zero external APIs (no Spotify, no paid anything).
//
// Confession Train: post anonymously; it rides a "train" to random people who
//   can reply (text or voice note). Author identity is NEVER exposed. Lives 24h.
// Music Sync: two people in a DM listen to the SAME user-uploaded audio clip in
//   real time — play/pause/seek relayed over sockets (see sockets.js). We host
//   nothing but the clip the user already uploaded through /upload.
// ============================================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { httpErr } from './auth.js';

export const chaos = Router();

// ---- schema (idempotent, matches the db.js pattern) ------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS confessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- private, never sent to clients
  body       TEXT NOT NULL,
  mood       TEXT,
  salt       TEXT,                            -- random, server-only: anon tags can't be reversed by guessing user ids
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS confession_seen (
  confession_id INTEGER NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  PRIMARY KEY (confession_id, user_id)
);
CREATE TABLE IF NOT EXISTS confession_replies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  confession_id INTEGER NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
  author_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- private
  body          TEXT NOT NULL DEFAULT '',
  attachment    TEXT,                       -- JSON upload descriptor (voice note)
  created_at    INTEGER NOT NULL
);
`);
try { db.exec(`ALTER TABLE confessions ADD COLUMN salt TEXT`); } catch { /* already there */ }

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' }); }
};

const TTL = 24 * 3600_000;
const sweep = () => db.prepare(`DELETE FROM confessions WHERE expires_at < ?`).run(now());

// A stable anonymous handle per (confession, person). It's derived from a random
// per-confession SALT that never leaves the server — so no one can enumerate
// user ids and recompute the tag to deanonymize a confessor.
function anonTag(salt, userId) {
  const h = crypto.createHash('sha256').update(String(salt || '') + ':' + userId).digest();
  return 'anon #' + (h.readUInt16BE(0) % 900 + 100);
}

// -------------------------------------------------- post a confession -----
chaos.post('/confessions', wrap((req, res) => {
  sweep();
  const body = String(req.body?.body || '').trim();
  if (body.length < 3) throw httpErr(400, 'Say a little more.');
  if (body.length > 800) throw httpErr(400, 'Keep it under 800 characters.');
  const mood = MOODS_OK.has(req.body?.mood) ? req.body.mood : null;
  const salt = crypto.randomBytes(9).toString('base64url');
  const r = db.prepare(`INSERT INTO confessions (author_id, body, mood, salt, created_at, expires_at) VALUES (?,?,?,?,?,?)`)
    .run(req.userId, body, mood, salt, now(), now() + TTL);
  // The author has "seen" their own confession so it never rides back to them
  db.prepare(`INSERT OR IGNORE INTO confession_seen (confession_id, user_id, at) VALUES (?,?,?)`).run(r.lastInsertRowid, req.userId, now());
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
}));
const MOODS_OK = new Set(['joy', 'love', 'hyped', 'jk', 'unsure', 'serious', 'down', 'blown']);

// ---------------------------------------- the train: next unseen one -----
chaos.get('/confessions/next', wrap((req, res) => {
  sweep();
  const c = db.prepare(`
    SELECT * FROM confessions
    WHERE expires_at > ? AND author_id != ?
      AND id NOT IN (SELECT confession_id FROM confession_seen WHERE user_id = ?)
    ORDER BY RANDOM() LIMIT 1
  `).get(now(), req.userId, req.userId);
  if (!c) return res.json({ confession: null, waiting: db.prepare(`SELECT COUNT(*) AS c FROM confessions WHERE expires_at>?`).get(now()).c });
  db.prepare(`INSERT OR IGNORE INTO confession_seen (confession_id, user_id, at) VALUES (?,?,?)`).run(c.id, req.userId, now());
  const replies = db.prepare(`SELECT * FROM confession_replies WHERE confession_id=? ORDER BY id ASC`).all(c.id);
  res.json({
    confession: {
      id: c.id, body: c.body, mood: c.mood, created_at: c.created_at,
      author: anonTag(c.salt, c.author_id),
      replies: replies.map(rp => ({
        id: rp.id, body: rp.body, created_at: rp.created_at,
        attachment: rp.attachment ? JSON.parse(rp.attachment) : null,
        author: anonTag(c.salt, rp.author_id),
      })),
    },
  });
}));

// ------------------------------------------- reply (text or voice) -----
chaos.post('/confessions/:id/reply', wrap((req, res) => {
  const c = db.prepare(`SELECT * FROM confessions WHERE id=? AND expires_at>?`).get(req.params.id, now());
  if (!c) throw httpErr(404, 'That confession already left the station.');
  const body = String(req.body?.body || '').trim().slice(0, 500);
  let att = null;
  const a = req.body?.attachment;
  if (a && typeof a === 'object' && typeof a.url === 'string' && a.url.startsWith('/files/') && !a.url.includes('..')) {
    att = JSON.stringify({ url: a.url, name: String(a.name || 'voice').slice(0, 120), type: String(a.type || '').slice(0, 60), size: Number(a.size) || 0 });
  }
  if (!body && !att) throw httpErr(400, 'Empty reply.');
  const r = db.prepare(`INSERT INTO confession_replies (confession_id, author_id, body, attachment, created_at) VALUES (?,?,?,?,?)`)
    .run(c.id, req.userId, body, att, now());
  res.json({ ok: true, reply: { id: Number(r.lastInsertRowid), body, attachment: att ? JSON.parse(att) : null, author: anonTag(c.salt, req.userId), created_at: now() } });
}));

// ------------------------------------------ my own confessions' echoes ----
// You can see the replies your confessions collected — still fully anonymous.
chaos.get('/confessions/mine', wrap((req, res) => {
  sweep();
  const mine = db.prepare(`SELECT * FROM confessions WHERE author_id=? AND expires_at>? ORDER BY id DESC`).all(req.userId, now());
  res.json({
    confessions: mine.map(c => {
      const replies = db.prepare(`SELECT * FROM confession_replies WHERE confession_id=? ORDER BY id ASC`).all(c.id);
      return {
        id: c.id, body: c.body, mood: c.mood, created_at: c.created_at, expires_at: c.expires_at,
        replies: replies.map(rp => ({
          id: rp.id, body: rp.body, created_at: rp.created_at,
          attachment: rp.attachment ? JSON.parse(rp.attachment) : null,
          author: anonTag(c.salt, rp.author_id),
        })),
      };
    }),
  });
}));
