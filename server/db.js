// ============================================================================
// Ikvizz — Database layer (local-first, single file, zero external services)
// Uses Node's built-in SQLite driver (node:sqlite). The entire life of a user
// lives in one encrypted-at-rest-capable file they own. Swap for Postgres at
// scale — every query goes through this module, so the seam is clean.
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'aether.db'));

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);
db.exec(`PRAGMA busy_timeout = 5000;`); // server + backfill/tools may write concurrently

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_hue    INTEGER NOT NULL DEFAULT 210,      -- deterministic colorful avatars
  context       TEXT NOT NULL DEFAULT 'available', -- Context Engine: working|meeting|driving|sleeping|gym|vacation|deepwork|available
  context_note  TEXT DEFAULT '',
  context_scope TEXT NOT NULL DEFAULT 'all',       -- who may see the context: all|inner|none
  created_at    INTEGER NOT NULL
);

-- Layer 1: Dynamic Identity — every relationship sees a different version of you
CREATE TABLE IF NOT EXISTS personas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,          -- Professional | Friend | Family | Gaming | Study ...
  emoji      TEXT NOT NULL DEFAULT '🌐',
  bio        TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Layer 2: Relationship Graph — typed, weighted relationships, not "contacts"
CREATE TABLE IF NOT EXISTS relationships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'Friend',  -- Mother|Close Friend|Manager|Mentor|Student|Doctor|Investor|Friend...
  closeness    INTEGER NOT NULL DEFAULT 2,      -- 1 inner circle · 2 regular · 3 outer — feeds priority + context visibility
  persona_id   INTEGER REFERENCES personas(id) ON DELETE SET NULL, -- which version of ME they see
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, other_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'dm',        -- dm | space
  space_id   INTEGER,
  a_id       INTEGER,                           -- dm participants (a < b)
  b_id       INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(a_id, b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal',   -- Priority Streams: critical|important|interesting|normal
  signals         TEXT NOT NULL DEFAULT '[]',       -- JSON: what the brain noticed (promise, idea, question, date...)
  reply_to        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS reads (
  conversation_id INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Layer 3: Memory Engine — "Remember this forever."
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  note       TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Promises: detected commitments ("I'll send it by Friday") — feeds the Daily Briefing
CREATE TABLE IF NOT EXISTS promises (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who promised
  to_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,          -- to whom
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  due_hint   TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',  -- open | kept | dropped
  created_at INTEGER NOT NULL
);

-- Living Spaces: not chat rooms — a chat + ideas + tasks + decisions + timeline
CREATE TABLE IF NOT EXISTS spaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '🚀',
  description TEXT DEFAULT '',
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS space_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                 -- idea | task | decision | milestone
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',  -- open | done
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Layer 7 (seed of the Knowledge Graph): timeline events per relationship
CREATE TABLE IF NOT EXISTS timeline_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  other_id   INTEGER NOT NULL,
  type       TEXT NOT NULL,      -- first_message | promise | memory | idea | milestone
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ========================== Ikvizz EDU ======================================
-- Knowledge Universe: concepts are planets. Mastery = brightness, and it
-- decays over time — dimming planets tell you what to review.
CREATE TABLE IF NOT EXISTS concepts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  emoji        TEXT NOT NULL DEFAULT '🪐',
  notes        TEXT DEFAULT '',
  mastery      REAL NOT NULL DEFAULT 10,   -- 0..100 at last study time
  last_studied INTEGER NOT NULL,           -- decay is computed from this
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS concept_links (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, -- prerequisite
  to_id   INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, -- depends on it
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS study_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  quality    INTEGER NOT NULL,             -- 1 struggled · 2 okay · 3 mastered
  created_at INTEGER NOT NULL
);

-- ========================== Ikvizz LIFE =====================================
-- Digital Home: rooms of your life, each alive with items and due dates.
CREATE TABLE IF NOT EXISTS life_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room       TEXT NOT NULL,                -- kitchen|bedroom|study|garage|vault|money|family
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  due_at     INTEGER,                      -- optional deadline, feeds the Daily Briefing
  status     TEXT NOT NULL DEFAULT 'open', -- open | done
  created_at INTEGER NOT NULL
);

-- The Garden: habits grow with streaks 🌱→🌳
CREATE TABLE IF NOT EXISTS habits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '🌱',
  streak     INTEGER NOT NULL DEFAULT 0,
  last_done  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Full-text memory over everything said, remembered, and created
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind, ref_id UNINDEXED, owner_hint UNINDEXED, body, tokenize='porter unicode61'
);
`);

// ---------------------------------------------------------------------------
// Lightweight migrations — additive columns only, safe to re-run
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  `ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`, // text | sealed (E2E)
  `ALTER TABLE messages ADD COLUMN attachment TEXT`,                   // JSON {url,name,type,size}
  `ALTER TABLE users ADD COLUMN public_key TEXT`,                      // ECDH P-256 public JWK (E2E)
  `ALTER TABLE messages ADD COLUMN edited_at INTEGER`,                 // last edit timestamp
  `ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,// soft delete
  `ALTER TABLE messages ADD COLUMN unlock_at INTEGER`,                 // Time Capsules: hidden until this moment
  `ALTER TABLE users ADD COLUMN phone TEXT`,                           // optional discovery handle (WhatsApp-style)
  `ALTER TABLE users ADD COLUMN mood TEXT`,                            // Mood Canvas: your current Ikvizz mood blob
  `ALTER TABLE users ADD COLUMN email TEXT`,                           // set by Google sign-in
  `ALTER TABLE users ADD COLUMN google_sub TEXT`,                      // Google account id (subject)
  `ALTER TABLE users ADD COLUMN avatar_url TEXT`,                      // profile photo (local upload or Google picture)
  `ALTER TABLE relationships ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE relationships ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN supabase_id TEXT`,                     // Supabase auth.users uuid (Milestone 3)
  `ALTER TABLE conversations ADD COLUMN cloud_id TEXT`,                // Supabase public.chats uuid (Milestone 4)
  `ALTER TABLE messages ADD COLUMN cloud_id TEXT`,                     // Supabase public.messages uuid (Milestone 4)
  `ALTER TABLE stories ADD COLUMN cloud_id TEXT`,                      // Supabase public.stories uuid (Milestone 4)
  `ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'`,// general | study (Study Rooms live in EDU)
  `ALTER TABLE spaces ADD COLUMN mood TEXT`,                           // MoodSync Rooms: the shared mood blob
  `ALTER TABLE spaces ADD COLUMN expires_at INTEGER`,                  // MoodSync Rooms: dissolve moment (6h)
  `ALTER TABLE spaces ADD COLUMN dissolved_at INTEGER`,                // MoodSync Rooms: set once the capsule is written
  `ALTER TABLE users ADD COLUMN rizz_king_until INTEGER`,              // Rizz Battle: 24h crown
  `ALTER TABLE users ADD COLUMN avatar_config TEXT`,                   // Avatar creator: JSON of layered-SVG choices
];
for (const sql of MIGRATIONS) {
  try { db.exec(sql); } catch { /* column already exists */ }
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;`);

// Moments (stories): expire after 24h, scoped to everyone or inner circle
db.exec(`
CREATE TABLE IF NOT EXISTS stories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'text',        -- text | image
  body       TEXT DEFAULT '',
  attachment TEXT,                                 -- JSON upload descriptor for image moments
  scope      TEXT NOT NULL DEFAULT 'all',          -- all | inner
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  opt        INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_views (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  viewed_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);`);

// Future Reminders: "next time I talk to X, bring up…"
db.exec(`
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);`);

// Pinned messages: important things float to the top of any chat (DM or space)
db.exec(`
CREATE TABLE IF NOT EXISTS pins (
  conversation_id INTEGER NOT NULL,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);`);

// Notification center: mention / reaction / call / story land here — Priority
// Streams still decide what INTERRUPTS; this is the quiet, honest record.
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,               -- mention | reaction | call | story
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',  -- JSON: {conversationId, ...}
  read       INTEGER NOT NULL DEFAULT 0,
  cloud_id   TEXT,                        -- Supabase public.notifications uuid
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,            -- Web Push subscription endpoint URL
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);

// Ikvizz EDU: assignments (deadlines feed the Daily Briefing) + flash cards
// (spaced recall that reuses the same honest mastery machinery)
db.exec(`
CREATE TABLE IF NOT EXISTS assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  concept_id INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
  due_at     INTEGER,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS flashcards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  reps       INTEGER NOT NULL DEFAULT 0,
  last_grade INTEGER,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);`);

// Ikvizz LIFE: goals — long arcs with honest progress, not just todo items
db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT 'target',
  progress   INTEGER NOT NULL DEFAULT 0,  -- 0..100, moved by the human, honestly
  due_at     INTEGER,
  status     TEXT NOT NULL DEFAULT 'open',-- open | done | dropped
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);`);

// Cloud outbox (Milestone 4): every local write that must reach Supabase is a
// row here. Idempotent sync-current-state items, coalesced by (kind, key), so
// a crash or a dead network never loses a message — it just flushes later.
db.exec(`
CREATE TABLE IF NOT EXISTS cloud_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,               -- user|chat|message|reactions|votes|read|story|storydel
  key        TEXT NOT NULL,               -- local ref, e.g. "12" or "3:7"
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL DEFAULT 0,  -- backoff gate
  created_at INTEGER NOT NULL,
  UNIQUE(kind, key)
);`);

// Roast My Life: submit yourself for roasting in a space. Replies are shown
// anonymously (we still KNOW who wrote what — anonymity is a costume, not a
// shield), and the roastee holds the "Save Me" button that ends it.
db.exec(`
CREATE TABLE IF NOT EXISTS roasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the brave roastee
  body       TEXT DEFAULT '',
  attachment TEXT,                                 -- JSON upload descriptor (the photo)
  status     TEXT NOT NULL DEFAULT 'live',         -- live | saved
  created_at INTEGER NOT NULL,
  saved_at   INTEGER
);
CREATE TABLE IF NOT EXISTS roast_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  roast_id   INTEGER NOT NULL REFERENCES roasts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,                     -- never sent to clients
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);

// Rizz Battle: 1v1, one line each, judged by local Ollama if present —
// an honest heuristic otherwise. Winner wears the crown for 24 hours.
db.exec(`
CREATE TABLE IF NOT EXISTS rizz_battles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario        TEXT NOT NULL,
  challenger_line TEXT,
  opponent_line   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | judged
  winner_id       INTEGER,
  engine          TEXT,                            -- ollama:<model> | heuristic
  verdict         TEXT,
  created_at      INTEGER NOT NULL,
  judged_at       INTEGER
);`);

// Reactions: expression through the Ikvizz icon language (heart, flame, bulb…)
db.exec(`
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, kind)
);`);

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
export const now = () => Date.now();

export function ftsIndex(kind, refId, ownerHint, body) {
  db.prepare(`INSERT INTO fts (kind, ref_id, owner_hint, body) VALUES (?, ?, ?, ?)`)
    .run(kind, String(refId), String(ownerHint ?? ''), body);
}

/** Escape user input for an FTS5 MATCH query (quote every token). */
export function ftsQuery(q) {
  const tokens = q.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(' ');
}

export function getOrCreateDm(userA, userB) {
  const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
  const existing = db.prepare(`SELECT * FROM conversations WHERE kind='dm' AND a_id=? AND b_id=?`).get(a, b);
  if (existing) return existing;
  const r = db.prepare(`INSERT INTO conversations (kind, a_id, b_id, created_at) VALUES ('dm', ?, ?, ?)`)
    .run(a, b, now());
  return db.prepare(`SELECT * FROM conversations WHERE id=?`).get(r.lastInsertRowid);
}

export function conversationMemberIds(convo) {
  if (convo.kind === 'dm') return [convo.a_id, convo.b_id];
  return db.prepare(`SELECT user_id FROM space_members WHERE space_id=?`).all(convo.space_id).map(r => r.user_id);
}

export function userCanAccessConversation(userId, convo) {
  return conversationMemberIds(convo).includes(userId);
}
