// ============================================================================
// IKVIZZ — Web Push, zero dependencies (Phase 9: Notifications).
//
// Real background push through the browser's push service (FCM for
// Chrome/Edge, Mozilla autopush for Firefox — all free), implemented straight
// from the RFCs with node:crypto:
//   · VAPID (RFC 8292): an ES256 JWT proves this server is the sender
//   · aes128gcm (RFC 8188/8291): the payload is encrypted end-to-end so the
//     push service relays bytes it cannot read
// Apple/APNs is deliberately NOT wired (project decision) — Safari/iOS users
// simply don't get background pushes; the in-app notification center covers
// them.
//
// The VAPID keypair is generated once and lives in data/vapid.json — local,
// like everything else.
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, '..', 'data', 'vapid.json');

const b64u = buf => Buffer.from(buf).toString('base64url');

let vapid = null;
function keys() {
  if (vapid) return vapid;
  try { vapid = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); return vapid; } catch { /* first boot */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vapid = {
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
  fs.writeFileSync(KEY_FILE, JSON.stringify(vapid));
  return vapid;
}

/** The applicationServerKey the browser needs: uncompressed P-256 point. */
export function vapidPublicKey() {
  const { publicJwk } = keys();
  return b64u(Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url'),
  ]));
}

function vapidJwt(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:aether@localhost.invalid',
  }));
  const key = crypto.createPrivateKey({ key: keys().privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${payload}.${b64u(sig)}`;
}

/** RFC 8291 payload encryption — the push service sees only ciphertext. */
function encrypt(payload, p256dh, auth) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // uncompressed, 65 bytes
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), // 0x02 = last record
    cipher.final(), cipher.getAuthTag(),
  ]);
  // aes128gcm header: salt(16) · record size 4096 (u32be) · keyid len · as_public
  return Buffer.concat([salt, Buffer.from([0, 0, 16, 0]), Buffer.from([asPublic.length]), asPublic, sealed]);
}

/**
 * Deliver one push. Returns { ok, status, gone } — `gone` means the browser
 * revoked the subscription (uninstall, permissions) and the row should die.
 */
export async function sendPush(sub, payloadObj) {
  const body = encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
      Authorization: `vapid t=${vapidJwt(sub.endpoint)}, k=${vapidPublicKey()}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
