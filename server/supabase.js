// ============================================================================
// Ikvizz — Supabase Auth (zero extra dependencies), Milestone 3.
//
// Supabase is the identity provider; Ikvizz stays the app. The client talks
// to Supabase's GoTrue REST API directly (sign-up / sign-in / confirmation
// emails), obtains an access token, and exchanges it here for a local Ikvizz
// session — exactly the same seam as Sign in with Google:
//
//    verify external token → find-or-create local user → issue local JWT
//
// Verification is done properly and locally: we fetch the project's JWKS and
// check the ES256 signature with node crypto, then validate issuer / expiry /
// audience. If the project still signs with a legacy shared secret (HS256) —
// which we don't have and shouldn't want — we fall back to asking the auth
// server itself (GET /auth/v1/user), which is authoritative either way.
//
// Enable by setting SUPABASE_URL + SUPABASE_ANON_KEY in .env (the
// NEXT_PUBLIC_* spellings from the Supabase dashboard work too).
// ============================================================================
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { httpErr, normalizePhone } from './auth.js';

export const SUPABASE_URL =
  (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '') || null;
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
export const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let jwks = { at: 0, keys: [] };
async function supabaseKeys() {
  if (Date.now() - jwks.at < 3600_000 && jwks.keys.length) return jwks.keys;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw httpErr(502, 'Could not reach Supabase to verify the sign-in.');
  jwks = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwks.keys;
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Ask the auth server who this token belongs to — the fallback verifier. */
async function verifyViaAuthServer(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw httpErr(401, 'Supabase session is not valid — please sign in again.');
  const u = await r.json();
  if (!u?.id) throw httpErr(401, 'Supabase session is not valid — please sign in again.');
  return { sub: u.id, email: u.email, user_metadata: u.user_metadata || {} };
}

/** Verify a Supabase access token end-to-end. Returns the payload or throws. */
export async function verifySupabaseToken(token) {
  if (!SUPABASE_ENABLED) throw httpErr(501, 'Supabase sign-in is not configured on this server yet.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw httpErr(400, 'Malformed Supabase access token.');
  const header = b64json(parts[0]);
  const payload = b64json(parts[1]);

  const jwk = header.kid ? (await supabaseKeys()).find(k => k.kid === header.kid) : null;
  if (!jwk) return verifyViaAuthServer(token); // HS256 legacy or unknown key — let GoTrue judge

  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const algo = header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256'; // ES256 → ECDSA P-256 + SHA-256
  const opts = header.alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub;
  const valid = crypto.verify(algo,
    Buffer.from(parts[0] + '.' + parts[1]), opts, Buffer.from(parts[2], 'base64url'));

  if (!valid) throw httpErr(401, 'Supabase signature check failed.');
  if (payload.iss !== `${SUPABASE_URL}/auth/v1`) throw httpErr(401, 'Unexpected token issuer.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes('authenticated')) throw httpErr(401, 'Token was issued for a different audience.');
  if (payload.exp * 1000 < Date.now()) throw httpErr(401, 'Supabase session expired — sign in again.');
  if (!payload.sub) throw httpErr(401, 'Token has no subject.');
  return payload;
}

/** Find-or-create the Ikvizz account behind a verified Supabase payload. */
export function userForSupabase(payload) {
  // 1) already linked by Supabase id
  let user = db.prepare(`SELECT * FROM users WHERE supabase_id=?`).get(payload.sub);
  if (user) return user;
  // 2) an existing account with this email → link it (covers Google-born
  //    accounts and re-created Supabase projects alike)
  if (payload.email) {
    user = db.prepare(`SELECT * FROM users WHERE email=?`).get(payload.email);
    if (user) {
      db.prepare(`UPDATE users SET supabase_id=? WHERE id=?`).run(payload.sub, user.id);
      return db.prepare(`SELECT * FROM users WHERE id=?`).get(user.id);
    }
  }
  // 3) brand new — honor the username chosen at sign-up (it travels in
  //    user_metadata), else derive one from the email
  const meta = payload.user_metadata || {};
  let base = /^[a-z0-9_]{3,24}$/.test(meta.username || '') ? meta.username
    : (payload.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20) || 'traveler';
  if (base.length < 3) base = 'user_' + base;
  let uname = base;
  for (let i = 2; db.prepare(`SELECT id FROM users WHERE username=?`).get(uname); i++) uname = `${base}${i}`;
  let phone = meta.phone ? normalizePhone(meta.phone) : null;
  if (phone && db.prepare(`SELECT id FROM users WHERE phone=?`).get(phone)) phone = null; // taken → skip, never block sign-in
  const hue = Math.abs([...uname].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 360;
  const r = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, avatar_hue, created_at, email, supabase_id, avatar_url, phone)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(uname, 'supabase-auth:' + crypto.randomBytes(24).toString('hex'), // password lives in Supabase, not here
    meta.full_name || meta.display_name || uname, hue, now(), payload.email || null, payload.sub, meta.avatar_url || null, phone);
  const userId = Number(r.lastInsertRowid);
  const p = db.prepare(`INSERT INTO personas (user_id, name, emoji, bio, created_at) VALUES (?,?,?,?,?)`);
  p.run(userId, 'Personal', 'smile', '', now());
  p.run(userId, 'Professional', 'briefcase', '', now());
  return db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
}
