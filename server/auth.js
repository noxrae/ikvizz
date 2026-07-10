// ============================================================================
// IKVIZZ — Auth (JWT, local). No third-party identity provider for the MVP;
// Keycloak/Supabase can replace this module behind the same middleware seam.
// ============================================================================
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, '..', 'data', '.jwt-secret');

// Session-signing secret. In the cloud (ephemeral disks) set JWT_SECRET so
// logins survive restarts/redeploys; otherwise we persist a random one to the
// local data dir (never committed) so single-box installs stay stable.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8');
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, s);
    return s;
  } catch {
    // read-only filesystem (some hosts) → fall back to an in-memory secret
    return crypto.randomBytes(48).toString('hex');
  }
}
export const JWT_SECRET = loadSecret();

/** Normalize a phone number to digits (keeps leading +). */
export function normalizePhone(raw) {
  const p = String(raw || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return /^\+?\d{7,15}$/.test(p) ? p : null;
}

export function createUser({ username, password, displayName, phone }) {
  const uname = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(uname)) throw httpErr(400, 'Username must be 3–24 chars: letters, numbers, underscore.');
  if (String(password || '').length < 6) throw httpErr(400, 'Password must be at least 6 characters.');
  const exists = db.prepare(`SELECT id FROM users WHERE username=?`).get(uname);
  if (exists) throw httpErr(409, 'That username is taken.');
  // Phone is OPTIONAL — an Instagram-style username identity with a
  // WhatsApp-style discovery handle on top. No SMS gatekeeping.
  let ph = null;
  if (phone && String(phone).trim()) {
    ph = normalizePhone(phone);
    if (!ph) throw httpErr(400, 'That phone number does not look right.');
    if (db.prepare(`SELECT id FROM users WHERE phone=?`).get(ph)) throw httpErr(409, 'That phone number is already connected to an account.');
  }
  const hue = Math.abs([...uname].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 360;
  const r = db.prepare(`INSERT INTO users (username, password_hash, display_name, avatar_hue, created_at, phone) VALUES (?,?,?,?,?,?)`)
    .run(uname, bcrypt.hashSync(password, 10), displayName?.trim() || uname, hue, now(), ph);
  const userId = Number(r.lastInsertRowid);
  // Every human starts with two identities — the seed of Dynamic Identity.
  // (emoji column carries IKVIZZ icon names — the client renders our own icons)
  const p = db.prepare(`INSERT INTO personas (user_id, name, emoji, bio, created_at) VALUES (?,?,?,?,?)`);
  p.run(userId, 'Personal', 'smile', '', now());
  p.run(userId, 'Professional', 'briefcase', '', now());
  return db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
}

export function verifyLogin(username, password) {
  const handle = String(username || '').trim().toLowerCase();
  // username OR email — one box, both work
  const user = handle.includes('@')
    ? db.prepare(`SELECT * FROM users WHERE email=?`).get(handle)
    : db.prepare(`SELECT * FROM users WHERE username=?`).get(handle);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw httpErr(401, 'Invalid username or password.');
  }
  return user;
}

export function issueToken(user) {
  return jwt.sign({ uid: user.id, uname: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again.' });
  }
}

export function verifySocketToken(token) {
  try { return jwt.verify(token, JWT_SECRET).uid; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Session cookie — lets same-origin <img>/<audio> requests to /files carry
// auth (they can't send an Authorization header). httpOnly so JS can't read it;
// SameSite=Lax; no Secure flag on localhost/http (add it behind HTTPS).
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'aether_sess';
export function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax${secure}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}
/** Read + verify the session cookie. Returns uid or null. No dependency. */
export function uidFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(/;\s*/).find(c => c.startsWith(SESSION_COOKIE + '='));
  if (!m) return null;
  try { return jwt.verify(decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)), JWT_SECRET).uid; }
  catch { return null; }
}
/** Express gate for /files — only signed-in IKVIZZ users may fetch uploads. */
export function fileGate(req, res, next) {
  if (uidFromCookie(req)) return next();
  res.status(403).type('text/plain').send('Sign in to view this file.');
}

export function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function publicUser(u) {
  if (!u) return null;
  const { id, username, display_name, avatar_hue, context, context_note, context_scope, mood, avatar_url, avatar_config, rizz_king_until } = u;
  return { id, username, display_name, avatar_hue, context, context_note, context_scope, mood, avatar_url, avatar_config: avatar_config || null, rizz_king_until: rizz_king_until || null };
}
