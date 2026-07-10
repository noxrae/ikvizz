// ============================================================================
// IKVIZZ — Sign in with Google (zero extra dependencies).
//
// Client uses Google Identity Services to obtain an ID token; we verify it
// here properly: fetch Google's JWKS, check the RS256 signature with node
// crypto, then validate audience / issuer / expiry / email_verified.
//
// Enable by setting GOOGLE_CLIENT_ID (env var) — get one free at
// https://console.cloud.google.com/apis/credentials (OAuth client, Web,
// authorized JS origin: http://localhost:4321). Until then the endpoint
// reports "not configured" and the UI explains how to turn it on.
// ============================================================================
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { httpErr } from './auth.js';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;

let certs = { at: 0, keys: [] };
async function googleKeys() {
  if (Date.now() - certs.at < 3600_000 && certs.keys.length) return certs.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw httpErr(502, 'Could not reach Google to verify the sign-in.');
  certs = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certs.keys;
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Verify a Google ID token end-to-end. Returns the payload or throws. */
export async function verifyGoogleToken(credential) {
  if (!GOOGLE_CLIENT_ID) throw httpErr(501, 'Google sign-in is not configured on this server yet.');
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw httpErr(400, 'Malformed Google credential.');
  const header = b64json(parts[0]);
  const payload = b64json(parts[1]);

  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw httpErr(401, 'Unknown Google signing key.');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]), pub, Buffer.from(parts[2], 'base64url'));

  if (!valid) throw httpErr(401, 'Google signature check failed.');
  if (payload.aud !== GOOGLE_CLIENT_ID) throw httpErr(401, 'Token was issued for a different app.');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) throw httpErr(401, 'Unexpected token issuer.');
  if (payload.exp * 1000 < Date.now()) throw httpErr(401, 'Google session expired — try again.');
  if (!payload.email || payload.email_verified === false) throw httpErr(401, 'Google account has no verified email.');
  return payload;
}

/**
 * Verify a Google OAuth2 access token (from the custom-button popup flow) by
 * calling Google's userinfo endpoint. Returns a payload shaped like the ID
 * token so userForGoogle() can consume either path.
 */
export async function verifyGoogleAccessToken(accessToken) {
  if (!GOOGLE_CLIENT_ID) throw httpErr(501, 'Google sign-in is not configured on this server yet.');
  const at = String(accessToken || '');
  if (!at) throw httpErr(400, 'Missing Google access token.');
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + at }, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw httpErr(401, 'Could not verify your Google sign-in — please try again.');
  const info = await r.json();
  if (!info.sub) throw httpErr(401, 'Google did not return an account id.');
  if (!info.email || info.email_verified === false) throw httpErr(401, 'Your Google account has no verified email.');
  return { sub: info.sub, email: info.email, email_verified: info.email_verified, name: info.name, picture: info.picture };
}

/** Find-or-create the IKVIZZ account behind a verified Google payload. */
export function userForGoogle(payload) {
  // 1) already linked by Google id
  let user = db.prepare(`SELECT * FROM users WHERE google_sub=?`).get(payload.sub);
  if (user) return user;
  // 2) an existing account with this email → link it
  user = db.prepare(`SELECT * FROM users WHERE email=?`).get(payload.email);
  if (user) {
    db.prepare(`UPDATE users SET google_sub=? WHERE id=?`).run(payload.sub, user.id);
    return db.prepare(`SELECT * FROM users WHERE id=?`).get(user.id);
  }
  // 3) brand new — derive a username from the email, uniquify if needed
  let base = payload.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20) || 'traveler';
  if (base.length < 3) base = 'user_' + base;
  let uname = base;
  for (let i = 2; db.prepare(`SELECT id FROM users WHERE username=?`).get(uname); i++) uname = `${base}${i}`;
  const hue = Math.abs([...uname].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 360;
  const r = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, avatar_hue, created_at, email, google_sub, avatar_url)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(uname, 'google-oauth:' + crypto.randomBytes(24).toString('hex'), // no password login for Google-born accounts
    payload.name || uname, hue, now(), payload.email, payload.sub, payload.picture || null);
  const userId = Number(r.lastInsertRowid);
  const p = db.prepare(`INSERT INTO personas (user_id, name, emoji, bio, created_at) VALUES (?,?,?,?,?)`);
  p.run(userId, 'Personal', 'smile', '', now());
  p.run(userId, 'Professional', 'briefcase', '', now());
  return db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
}
