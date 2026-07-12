// ============================================================================
// IKVIZZ — Durable persistence on ephemeral hosts (Supabase Storage).
//
// Render's free tier gives every deploy (and every wake-from-sleep) a BRAND NEW
// empty disk. Local-first SQLite is still the source of truth while the process
// lives — but the moment it restarts, `data/` is gone. This module closes that
// gap by snapshotting the WHOLE database file AND the uploaded-media folder to a
// private Supabase Storage bucket, and restoring them on boot BEFORE SQLite is
// opened. The result: redeploy / sleep / crash → your accounts, messages,
// memories, spaces and media all come back exactly as they were.
//
// Why the full file (not the Postgres mirror in cloud.js)? Because the file is
// the complete truth — every table, every feature — with zero mapping to get
// wrong. cloud.js mirrors only core messaging; this protects the entire app.
//
// Zero new dependencies: Node's global fetch + fs. Enable by setting
// SUPABASE_URL + SUPABASE_SECRET_KEY (service key) and running in production
// (or PERSIST_FORCE=1 to test locally). Snapshots are namespaced by PERSIST_KEY
// (default "prod") so a local test run never clobbers the live backup.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const URL_BASE = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '') || null;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || null;
// On only in production by default, so local dev never touches the live backup.
const ALLOWED = process.env.NODE_ENV === 'production' || process.env.PERSIST_FORCE === '1';
export const PERSIST_ENABLED = !!(URL_BASE && SERVICE_KEY && ALLOWED);

/** Status booleans for a health check — NEVER leaks the actual secret values. */
export const persistStatus = () => ({
  enabled: PERSIST_ENABLED,
  hasUrl: !!URL_BASE,
  hasKey: !!SERVICE_KEY,
  production: process.env.NODE_ENV === 'production',
  bucket: BUCKET,
  key: KEY,
});

const BUCKET = 'ikvizz-backups';
const KEY = process.env.PERSIST_KEY || 'prod';
const DB_OBJECT = `${KEY}/db/aether.db`;
const VAPID_OBJECT = `${KEY}/db/vapid.json`; // Web-Push keypair must be STABLE across
const UPLOADS_PREFIX = `${KEY}/uploads/`;    // redeploys, else push subscriptions break
const DB_NAME = 'aether.db';

const headers = (extra = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra });
let lastLog = '';
const log = msg => { if (msg !== lastLog) { lastLog = msg; console.log('[persist]', msg); } };

// ---------------------------------------------------------------------------
// Storage primitives (raw REST, service role)
// ---------------------------------------------------------------------------
let bucketReady = null;
async function ensureBucket() {
  bucketReady ||= (async () => {
    const r = await fetch(`${URL_BASE}/storage/v1/bucket/${BUCKET}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (r.ok) return;
    const c = await fetch(`${URL_BASE}/storage/v1/bucket`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!c.ok && c.status !== 409) throw new Error(`create bucket ${BUCKET}: ${c.status} ${(await c.text()).slice(0, 160)}`);
  })().catch(e => { bucketReady = null; throw e; });
  return bucketReady;
}

async function putObject(objectPath, buf, mime = 'application/octet-stream') {
  await ensureBucket();
  const r = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST', headers: headers({ 'Content-Type': mime, 'x-upsert': 'true' }),
    body: buf, signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`upload ${objectPath}: ${r.status} ${(await r.text()).slice(0, 160)}`);
}

/** Download an object → Buffer, or null if it doesn't exist yet. */
async function getObject(objectPath) {
  const r = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (r.status === 400 || r.status === 404) return null; // not backed up yet
  if (!r.ok) throw new Error(`download ${objectPath}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** List file names directly under a prefix (folders excluded). */
async function listObjects(prefix) {
  const r = await fetch(`${URL_BASE}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 10_000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : []).filter(x => x && x.id && x.name).map(x => x.name);
}

// ---------------------------------------------------------------------------
// Restore — runs BEFORE SQLite is opened (index.js awaits this first)
// ---------------------------------------------------------------------------
/**
 * If the local database is missing (fresh disk after a redeploy/sleep), pull the
 * latest snapshot — database file + all uploaded media — back down from Supabase.
 * A present local DB is always left untouched: local is the freshest truth.
 */
export async function restoreIfMissing(dataDir) {
  if (!PERSIST_ENABLED) return { restored: false, reason: 'disabled' };
  const dbPath = path.join(dataDir, DB_NAME);
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    return { restored: false, reason: 'local-db-present' };
  }
  try {
    const buf = await getObject(DB_OBJECT);
    if (!buf) { log('no cloud snapshot yet — starting fresh (first run)'); return { restored: false, reason: 'no-snapshot' }; }
    fs.mkdirSync(dataDir, { recursive: true });
    // Remove any stale WAL/SHM so the restored main file opens cleanly.
    for (const ext of ['-wal', '-shm']) { try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* none */ } }
    fs.writeFileSync(dbPath, buf);
    log(`restored database from cloud (${(buf.length / 1024).toFixed(0)} KB)`);

    // Restore the Web-Push keypair so existing push subscriptions keep working.
    try { const vb = await getObject(VAPID_OBJECT); if (vb) fs.writeFileSync(path.join(dataDir, 'vapid.json'), vb); } catch { /* regenerates if absent */ }

    // Restore uploaded media alongside it.
    const uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    let names = [];
    try { names = await listObjects(UPLOADS_PREFIX); } catch (e) { log('media list failed (continuing): ' + e.message); }
    let ok = 0;
    for (const name of names) {
      try {
        const fb = await getObject(UPLOADS_PREFIX + name);
        if (fb) { fs.writeFileSync(path.join(uploadsDir, name), fb); ok++; }
      } catch { /* skip a bad file, keep going */ }
    }
    if (names.length) log(`restored ${ok}/${names.length} media files`);
    return { restored: true, mediaFiles: ok };
  } catch (e) {
    // Never let a restore failure stop the app booting — worst case it starts empty.
    log('restore failed (starting fresh): ' + e.message);
    return { restored: false, reason: 'error', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Snapshot — runs AFTER SQLite is open (needs the db handle to checkpoint WAL)
// ---------------------------------------------------------------------------
const mirroredMedia = new Set(); // upload filenames already in the cloud this process
let snapping = false;
let lastDbMtime = 0;
let vapidUploaded = false;

async function seedMirroredMedia() {
  try { for (const n of await listObjects(UPLOADS_PREFIX)) mirroredMedia.add(n); }
  catch (e) { log('could not pre-list cloud media: ' + e.message); }
}

/** Take one consistent snapshot: fold the WAL into the main file, upload it, then
 *  push any new media files. Cheap when nothing changed (skips an unchanged DB). */
export async function snapshotNow(db, dataDir, { force = false } = {}) {
  if (!PERSIST_ENABLED || snapping) return;
  snapping = true;
  try {
    const dbPath = path.join(dataDir, DB_NAME);
    // Consistency: checkpoint + read the file synchronously (no await between),
    // so the bytes we send are a coherent database as of this instant.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best effort */ }
    const mtime = fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : 0;
    const changed = force || mtime !== lastDbMtime;
    if (changed) {
      const buf = fs.readFileSync(dbPath);
      await putObject(DB_OBJECT, buf, 'application/x-sqlite3');
      lastDbMtime = mtime;
      log(`snapshot uploaded (${(buf.length / 1024).toFixed(0)} KB)`);
    }
    // Web-Push keypair — tiny, rarely changes; upload once per process.
    if (!vapidUploaded) {
      const vp = path.join(dataDir, 'vapid.json');
      if (fs.existsSync(vp)) { try { await putObject(VAPID_OBJECT, fs.readFileSync(vp), 'application/json'); vapidUploaded = true; } catch { /* retry next tick */ } }
    }
    // Media: upload only files we haven't mirrored yet (uploads are immutable).
    const uploadsDir = path.join(dataDir, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      for (const name of fs.readdirSync(uploadsDir)) {
        if (mirroredMedia.has(name)) continue;
        try {
          await putObject(UPLOADS_PREFIX + name, fs.readFileSync(path.join(uploadsDir, name)));
          mirroredMedia.add(name);
        } catch (e) { log(`media upload ${name} failed (will retry): ${e.message}`); }
      }
    }
  } catch (e) {
    log('snapshot failed (will retry): ' + e.message);
  } finally {
    snapping = false;
  }
}

/** Start the background snapshotter + save-on-shutdown. Idempotent. */
let started = false;
export function startSnapshots(db, dataDir) {
  if (!PERSIST_ENABLED) {
    console.log('  IKVIZZ Persist: off (set SUPABASE_URL + SUPABASE_SECRET_KEY, NODE_ENV=production to survive redeploys)');
    return;
  }
  if (started) return;
  started = true;
  console.log(`  IKVIZZ Persist: on — snapshotting data → Supabase Storage (bucket "${BUCKET}", key "${KEY}")`);

  seedMirroredMedia().then(() => snapshotNow(db, dataDir, { force: true })); // first backup soon after boot
  const iv = setInterval(() => snapshotNow(db, dataDir), 25_000); // every 25s if changed — bounds worst-case loss
  iv.unref?.();

  // Save on the way out — Render sends SIGTERM before recycling the container.
  let leaving = false;
  const bye = async signal => {
    if (leaving) return; leaving = true;
    log(`${signal} — taking a final snapshot before exit`);
    try { await snapshotNow(db, dataDir, { force: true }); } catch { /* logged inside */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
}
