// ============================================================================
// Ikvizz — Cloud Messaging mirror (Milestone 4: Core Messaging → Supabase).
//
// Local-first stays true: SQLite remains the source of truth and the app
// never waits on the network. Every core-messaging write (chats, messages,
// edits, deletes, reactions, poll votes, read markers, moments, media) drops
// an idempotent "sync current state" item into the cloud_outbox table, and a
// background flusher pushes it into the Supabase Postgres schema that
// Milestones 1–2 created (public.chats / messages / attachments / stories…).
//
// Design rules, in the spirit of the rest of the codebase:
//   · zero new dependencies — `pg` (already here for migrations) + raw fetch
//   · idempotent upserts keyed by uuids minted locally (crypto.randomUUID),
//     so retries, crashes and concurrent flushers can never duplicate data
//   · items coalesce by (kind, key): ten edits of one message = one sync
//   · nothing is dropped silently — permanent failures are logged, transient
//     ones back off (max 5 min) and retry forever
//   · local-only demo users get a *shadow identity* in Supabase Auth (minted
//     lazily through the admin API, e.g. aarav@shadow.aether.invalid) so the
//     profiles/messages foreign keys hold; real Supabase accounts are linked
//     by the supabase_id column Milestone 3 added
//   · sealed messages mirror as ciphertext, capsules stay locked — the cloud
//     learns nothing the local server didn't already know
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { db, now } from './db.js';
import { SUPABASE_URL } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

const DB_URL = process.env.SUPABASE_DB_URL || null;
// Prefer the new-style secret key (sb_secret_…); fall back to the legacy
// service_role JWT if that's all that's configured.
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || null;
export const CLOUD_ENABLED = !!DB_URL;

const BUCKET = 'media';

// ---------------------------------------------------------------------------
// Postgres pool (lazy) — small and polite: the Supabase pooler is shared.
// ---------------------------------------------------------------------------
let pool = null;
function pgPool() {
  pool ||= new pg.Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  return pool;
}
const q = (sql, params = []) => pgPool().query(sql, params);

const permanent = msg => Object.assign(new Error(msg), { permanent: true });

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
function enqueue(kind, key) {
  if (!CLOUD_ENABLED) return;
  db.prepare(`INSERT OR IGNORE INTO cloud_outbox (kind, key, created_at) VALUES (?,?,?)`).run(kind, key, now());
  db.prepare(`UPDATE cloud_outbox SET next_at=0 WHERE kind=? AND key=?`).run(kind, key); // re-arm a backed-off duplicate
  kick();
}

/** The public seam — call these after any local core-messaging write. */
export const mirror = {
  chat: convoId => enqueue('chat', String(convoId)),
  message: messageId => enqueue('message', String(messageId)),
  reactions: messageId => enqueue('reactions', String(messageId)),
  votes: messageId => enqueue('votes', String(messageId)),
  read: (convoId, userId) => enqueue('read', `${convoId}:${userId}`),
  story: storyId => enqueue('story', String(storyId)),
  storyDelete: cloudId => cloudId && enqueue('storydel', String(cloudId)),
  notification: notifId => enqueue('notif', String(notifId)),
};

// ---------------------------------------------------------------------------
// Identity: local user → Supabase auth.users uuid (+ public.profiles row)
// ---------------------------------------------------------------------------
async function ensureCloudUser(localUserId) {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(localUserId);
  if (!u) throw permanent(`local user ${localUserId} is gone`);

  let uuid = u.supabase_id;
  if (!uuid) {
    // Local-only account (demo users, username sign-ups) → shadow identity.
    if (!SERVICE_KEY) throw new Error('need SUPABASE_SERVICE_KEY to mint a shadow identity for local user ' + u.username);
    const email = `${u.username}@shadow.aether.invalid`;
    const existing = await q(`SELECT id FROM auth.users WHERE email=$1`, [email]);
    if (existing.rowCount) {
      uuid = existing.rows[0].id;
    } else {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          email, email_confirm: true,
          password: crypto.randomBytes(24).toString('hex'), // never used; sign-in stays local
          user_metadata: { username: u.username, full_name: u.display_name, aether_shadow: true },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`shadow identity for ${u.username}: GoTrue ${r.status} ${(await r.text()).slice(0, 200)}`);
      uuid = (await r.json()).id;
    }
    db.prepare(`UPDATE users SET supabase_id=? WHERE id=?`).run(uuid, u.id);
  }

  // The signup trigger creates the profile row; make sure it's really there
  // (covers pre-trigger accounts and any trigger hiccup).
  const prof = await q(`SELECT id FROM public.profiles WHERE id=$1`, [uuid]);
  if (!prof.rowCount) {
    for (const uname of [u.username, `${u.username}_${uuid.slice(0, 4)}`]) {
      try {
        await q(`INSERT INTO public.profiles (id, username, display_name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
          [uuid, uname, u.display_name || uname]);
        break;
      } catch { /* username taken — retry with suffix */ }
    }
  }
  return uuid;
}

// ---------------------------------------------------------------------------
// Chats: local conversation (dm | space) → public.chats + chat_members
// ---------------------------------------------------------------------------
async function syncChat(convoId) {
  const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(convoId);
  if (!convo) throw permanent(`local conversation ${convoId} is gone`);

  if (!convo.cloud_id) {
    convo.cloud_id = crypto.randomUUID();
    db.prepare(`UPDATE conversations SET cloud_id=? WHERE id=?`).run(convo.cloud_id, convo.id);
  }

  let name = null, icon = null, description = null, ownerUuid = null;
  let members; // [{ localId, role }]
  if (convo.kind === 'dm') {
    members = [{ localId: convo.a_id, role: 'member' }, { localId: convo.b_id, role: 'member' }];
  } else {
    const space = db.prepare(`SELECT * FROM spaces WHERE id=?`).get(convo.space_id);
    if (!space) throw permanent(`space ${convo.space_id} behind conversation ${convoId} is gone`);
    name = space.name; icon = space.emoji; description = space.description;
    ownerUuid = await ensureCloudUser(space.owner_id);
    members = db.prepare(`SELECT user_id, role FROM space_members WHERE space_id=?`).all(space.id)
      .map(m => ({ localId: m.user_id, role: m.role === 'owner' ? 'owner' : 'member' }));
  }

  await q(`
    INSERT INTO public.chats (id, kind, name, icon, description, owner_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0))
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, icon=excluded.icon, description=excluded.description
  `, [convo.cloud_id, convo.kind === 'dm' ? 'dm' : 'group', name, icon, description, ownerUuid, convo.created_at]);

  const memberUuids = [];
  for (const m of members) {
    const userUuid = await ensureCloudUser(m.localId);
    memberUuids.push(userUuid);
    await q(`
      INSERT INTO public.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)
      ON CONFLICT (chat_id, user_id) DO UPDATE SET role=excluded.role
    `, [convo.cloud_id, userUuid, m.role]);
  }
  // People removed locally leave the cloud chat too
  await q(`DELETE FROM public.chat_members WHERE chat_id=$1 AND NOT (user_id = ANY($2::uuid[]))`,
    [convo.cloud_id, memberUuids]);
  return convo.cloud_id;
}

// ---------------------------------------------------------------------------
// Messages: full upsert of current local state (body, edit, delete, signals)
// ---------------------------------------------------------------------------
async function syncMessage(messageId, depth = 0) {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m) throw permanent(`local message ${messageId} is gone`);

  const chatUuid = await syncChat(m.conversation_id);
  const senderUuid = await ensureCloudUser(m.sender_id);
  const replyUuid = m.reply_to && depth < 5 ? await syncMessage(m.reply_to, depth + 1) : null;

  if (!m.cloud_id) {
    m.cloud_id = crypto.randomUUID();
    db.prepare(`UPDATE messages SET cloud_id=? WHERE id=?`).run(m.cloud_id, m.id);
  }

  const kind = ['text', 'sealed', 'poll'].includes(m.kind) ? m.kind : 'text';
  await q(`
    INSERT INTO public.messages (id, chat_id, sender_id, kind, body, priority, signals, reply_to, unlock_at, edited_at, deleted, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,
            CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9/1000.0) END,
            CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10/1000.0) END,
            $11, to_timestamp($12/1000.0))
    ON CONFLICT (id) DO UPDATE SET
      body=excluded.body, priority=excluded.priority, signals=excluded.signals,
      reply_to=excluded.reply_to, edited_at=excluded.edited_at, deleted=excluded.deleted
  `, [m.cloud_id, chatUuid, senderUuid, kind, m.body, m.priority, m.signals || '[]',
    replyUuid, m.unlock_at, m.edited_at, !!m.deleted, m.created_at]);

  // Media: push the local file into Supabase Storage exactly once; a deleted
  // message takes its cloud media down with it.
  if (m.deleted) {
    const atts = await q(`SELECT bucket, path FROM public.attachments WHERE message_id=$1`, [m.cloud_id]);
    for (const a of atts.rows) await deleteObject(a.bucket, a.path);
    await q(`DELETE FROM public.attachments WHERE message_id=$1`, [m.cloud_id]);
  } else if (m.attachment) {
    const att = JSON.parse(m.attachment);
    const fname = String(att.url || '').split('/').pop();
    const local = path.join(UPLOAD_DIR, fname || '');
    if (fname && fs.existsSync(local)) {
      const objectPath = `chat/${m.cloud_id}/${fname}`;
      const inserted = await q(`
        INSERT INTO public.attachments (message_id, bucket, path, name, mime, size)
        SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM public.attachments WHERE message_id=$1)
        RETURNING id
      `, [m.cloud_id, BUCKET, objectPath, att.name || fname, att.type || '', att.size || 0]);
      if (inserted.rowCount) await uploadObject(BUCKET, objectPath, fs.readFileSync(local), att.type || 'application/octet-stream');
    } else if (fname) {
      logOnce(`attachment file ${fname} missing locally — message ${m.id} mirrored without media`);
    }
  }
  return m.cloud_id;
}

async function syncReactions(messageId) {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId);
  if (!m) throw permanent(`local message ${messageId} is gone`);
  const cloudMsg = await syncMessage(messageId);
  const local = db.prepare(`SELECT user_id, kind FROM reactions WHERE message_id=?`).all(messageId);
  await q(`DELETE FROM public.message_reactions WHERE message_id=$1`, [cloudMsg]);
  for (const r of local) {
    const userUuid = await ensureCloudUser(r.user_id);
    await q(`INSERT INTO public.message_reactions (message_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [cloudMsg, userUuid, r.kind]);
  }
}

async function syncVotes(messageId) {
  const cloudMsg = await syncMessage(messageId);
  const local = db.prepare(`SELECT user_id, opt FROM poll_votes WHERE message_id=?`).all(messageId);
  await q(`DELETE FROM public.poll_votes WHERE message_id=$1`, [cloudMsg]);
  for (const v of local) {
    const userUuid = await ensureCloudUser(v.user_id);
    await q(`INSERT INTO public.poll_votes (message_id, user_id, opt) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [cloudMsg, userUuid, v.opt]);
  }
}

async function syncRead(convoId, userId) {
  const chatUuid = await syncChat(convoId);
  const userUuid = await ensureCloudUser(userId);
  const r = db.prepare(`SELECT last_read_id FROM reads WHERE conversation_id=? AND user_id=?`).get(convoId, userId);
  const at = r?.last_read_id
    ? db.prepare(`SELECT created_at FROM messages WHERE id=?`).get(r.last_read_id)?.created_at || now()
    : now();
  await q(`
    INSERT INTO public.message_reads (chat_id, user_id, last_read_at) VALUES ($1,$2,to_timestamp($3/1000.0))
    ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_at=excluded.last_read_at
  `, [chatUuid, userUuid, at]);
}

// ---------------------------------------------------------------------------
// Moments (stories) — row + media + views
// ---------------------------------------------------------------------------
async function syncStory(storyId) {
  const s = db.prepare(`SELECT * FROM stories WHERE id=?`).get(storyId);
  if (!s) throw permanent(`local story ${storyId} is gone`);
  const userUuid = await ensureCloudUser(s.user_id);

  if (!s.cloud_id) {
    s.cloud_id = crypto.randomUUID();
    db.prepare(`UPDATE stories SET cloud_id=? WHERE id=?`).run(s.cloud_id, s.id);
  }

  let bucket = null, objectPath = null;
  if (s.attachment) {
    const att = JSON.parse(s.attachment);
    const fname = String(att.url || '').split('/').pop();
    const local = path.join(UPLOAD_DIR, fname || '');
    if (fname && fs.existsSync(local)) {
      bucket = BUCKET; objectPath = `stories/${s.cloud_id}/${fname}`;
      const already = await q(`SELECT bucket FROM public.stories WHERE id=$1 AND path=$2`, [s.cloud_id, objectPath]);
      if (!already.rowCount) await uploadObject(BUCKET, objectPath, fs.readFileSync(local), att.type || 'application/octet-stream');
    }
  }

  const kind = ['text', 'image', 'video', 'voice', 'music'].includes(s.kind) ? s.kind : 'text';
  await q(`
    INSERT INTO public.stories (id, user_id, kind, body, bucket, path, scope, created_at, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($9/1000.0))
    ON CONFLICT (id) DO UPDATE SET body=excluded.body, bucket=excluded.bucket, path=excluded.path, scope=excluded.scope
  `, [s.cloud_id, userUuid, kind, s.body || '', bucket, objectPath,
    s.scope === 'inner' ? 'inner' : 'all', s.created_at, s.expires_at]);

  const views = db.prepare(`SELECT user_id, at FROM story_views WHERE story_id=?`).all(storyId);
  for (const v of views) {
    const viewer = await ensureCloudUser(v.user_id);
    await q(`INSERT INTO public.story_views (story_id, user_id, viewed_at) VALUES ($1,$2,to_timestamp($3/1000.0)) ON CONFLICT DO NOTHING`,
      [s.cloud_id, viewer, v.at]);
  }
}

async function syncNotification(notifId) {
  const n = db.prepare(`SELECT * FROM notifications WHERE id=?`).get(notifId);
  if (!n) throw permanent(`local notification ${notifId} is gone`);
  const userUuid = await ensureCloudUser(n.user_id);
  if (!n.cloud_id) {
    n.cloud_id = crypto.randomUUID();
    db.prepare(`UPDATE notifications SET cloud_id=? WHERE id=?`).run(n.cloud_id, n.id);
  }
  await q(`
    INSERT INTO public.notifications (id, user_id, kind, title, body, data, read, created_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,to_timestamp($8/1000.0))
    ON CONFLICT (id) DO UPDATE SET read=excluded.read
  `, [n.cloud_id, userUuid, n.kind, n.title, n.body || '', n.data || '{}', !!n.read, n.created_at]);
}

async function deleteCloudStory(cloudId) {
  const row = await q(`SELECT bucket, path FROM public.stories WHERE id=$1`, [cloudId]);
  if (row.rowCount && row.rows[0].path) await deleteObject(row.rows[0].bucket, row.rows[0].path);
  await q(`DELETE FROM public.stories WHERE id=$1`, [cloudId]);
}

// ---------------------------------------------------------------------------
// Supabase Storage (raw REST, service role)
// ---------------------------------------------------------------------------
let bucketReady = null;
function storageHeaders(extra = {}) {
  if (!SERVICE_KEY) throw new Error('need SUPABASE_SERVICE_KEY for Storage');
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

async function ensureBucket() {
  bucketReady ||= (async () => {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: storageHeaders(), signal: AbortSignal.timeout(10_000) });
    if (r.ok) return;
    const c = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST', headers: storageHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!c.ok && c.status !== 409) throw new Error(`could not create bucket "${BUCKET}": ${c.status} ${(await c.text()).slice(0, 200)}`);
  })().catch(e => { bucketReady = null; throw e; });
  return bucketReady;
}

async function uploadObject(bucket, objectPath, buf, mime) {
  await ensureBucket();
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buf,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`storage upload ${objectPath}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function deleteObject(bucket, objectPath) {
  if (!bucket || !objectPath) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'DELETE', headers: storageHeaders(), signal: AbortSignal.timeout(10_000),
  }).catch(() => { /* best effort — a re-run of the same item retries */ });
}

// ---------------------------------------------------------------------------
// Flusher
// ---------------------------------------------------------------------------
let flushing = false;
let kickTimer = null;
let lastLogged = '';

function logOnce(msg) {
  if (msg === lastLogged) return;
  lastLogged = msg;
  console.warn('[cloud]', msg);
}

function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; flushOnce(); }, 60);
}

async function processItem(it) {
  const n = Number(it.key);
  if (it.kind === 'user') return ensureCloudUser(n);
  if (it.kind === 'chat') return syncChat(n);
  if (it.kind === 'message') return syncMessage(n);
  if (it.kind === 'reactions') return syncReactions(n);
  if (it.kind === 'votes') return syncVotes(n);
  if (it.kind === 'read') { const [c, u] = it.key.split(':').map(Number); return syncRead(c, u); }
  if (it.kind === 'story') return syncStory(n);
  if (it.kind === 'storydel') return deleteCloudStory(it.key);
  if (it.kind === 'notif') return syncNotification(n);
  throw permanent(`unknown outbox kind ${it.kind}`);
}

export async function flushOnce() {
  if (!CLOUD_ENABLED || flushing) return;
  flushing = true;
  try {
    const items = db.prepare(`SELECT * FROM cloud_outbox WHERE next_at <= ? ORDER BY id LIMIT 50`).all(Date.now());
    let consecutiveFails = 0;
    for (const it of items) {
      try {
        await processItem(it);
        db.prepare(`DELETE FROM cloud_outbox WHERE id=?`).run(it.id);
        consecutiveFails = 0;
      } catch (e) {
        if (e.permanent) {
          logOnce(`dropping ${it.kind}:${it.key} — ${e.message}`);
          db.prepare(`DELETE FROM cloud_outbox WHERE id=?`).run(it.id);
          continue;
        }
        // Transient: back this ONE item off (exponential) and move on. A single
        // poison-but-retryable item must NOT block every later message/story.
        const wait = Math.min(300_000, 2000 * 2 ** Math.min(it.attempts, 8));
        try { db.prepare(`UPDATE cloud_outbox SET attempts=attempts+1, next_at=? WHERE id=?`).run(Date.now() + wait, it.id); }
        catch (e2) { logOnce(`outbox bookkeeping deferred: ${e2.message}`); }
        logOnce(`${it.kind}:${it.key} failed (retry in ${Math.round(wait / 1000)}s): ${e.message}`);
        // Only stop the batch if failures are piling up — that signals a global
        // outage (network/DB down), not a single bad item.
        if (++consecutiveFails >= 5) break;
      }
    }
  } finally {
    flushing = false;
  }
}

let interval = null;
export function startCloud() {
  if (!CLOUD_ENABLED) {
    console.log('  Ikvizz Cloud: off (set SUPABASE_DB_URL to mirror core messaging to Supabase)');
    return;
  }
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM cloud_outbox`).get().c;
  console.log(`  Ikvizz Cloud: mirroring core messaging → Supabase${pending ? ` (${pending} queued)` : ''}`);
  interval ||= setInterval(flushOnce, 2000);
  interval.unref?.();
  kick();
}

/** Enqueue every existing conversation/message/story — then let the flusher
    (this process's or the running server's; they share the outbox) drain it. */
export function cloudBackfill() {
  const convos = db.prepare(`SELECT id FROM conversations`).all();
  for (const c of convos) enqueue('chat', String(c.id));
  const msgs = db.prepare(`SELECT id FROM messages`).all();
  for (const m of msgs) enqueue('message', String(m.id));
  for (const r of db.prepare(`SELECT DISTINCT message_id FROM reactions`).all()) enqueue('reactions', String(r.message_id));
  for (const v of db.prepare(`SELECT DISTINCT message_id FROM poll_votes`).all()) enqueue('votes', String(v.message_id));
  for (const r of db.prepare(`SELECT conversation_id, user_id FROM reads`).all()) enqueue('read', `${r.conversation_id}:${r.user_id}`);
  const stories = db.prepare(`SELECT id FROM stories WHERE expires_at > ?`).all(now());
  for (const s of stories) enqueue('story', String(s.id));
  return { chats: convos.length, messages: msgs.length, stories: stories.length };
}

/** Keep flushing until the outbox is empty (used by the backfill script). */
export async function flushDrain(maxMs = 10 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    await flushOnce();
    const left = db.prepare(`SELECT COUNT(*) AS c FROM cloud_outbox WHERE next_at <= ?`).get(Date.now() + 1).c;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM cloud_outbox`).get().c;
    if (!total) return { drained: true };
    if (Date.now() - t0 > maxMs) return { drained: false, remaining: total };
    if (!left) await new Promise(r => setTimeout(r, 2000)); // everything is backing off
  }
}
