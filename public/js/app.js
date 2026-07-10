/* ============================================================================
   Ikvizz — SPA. No framework: a hash router, a socket, and honest DOM.
   Views: Today (briefing) · People (list + constellation map) · Chat ·
   Spaces · Space detail · Memory · Me. Ctrl+K = command palette.
   ============================================================================ */
import { icon, iconInSvg, PICKS, mood, MOODS, MOOD_KINDS } from './icons.js';
import { AV, AV_DEFAULT, normalizeAvatar, buildAvatar } from './avatar.js';

// ---------------------------------------------------------------- state -----
const S = {
  token: localStorage.getItem('aether_token') || null,
  me: null,
  personas: [],
  contexts: [],
  people: [],
  relKinds: [],
  socket: null,
  view: null,          // parsed route
  chat: null,          // active chat state {conversationId, messages, other, spaceMeta}
  peopleView: localStorage.getItem('aether_people_view') || 'bubbles',
  world: localStorage.getItem('aether_world') || 'now',
  intentTimers: {},
};
// If the remembered world has since been disabled, land safely in NOW
if (['edu', 'life'].includes(S.world)) { S.world = 'now'; localStorage.setItem('aether_world', 'now'); }

const CTX_META = { // [icon-name, label] — rendered through the Ikvizz icon system
  available: ['circleDot', 'Available'], working: ['briefcase', 'Working'], meeting: ['calendar', 'In a meeting'],
  deepwork: ['target', 'Locked in'], driving: ['car', 'Driving'], gym: ['dumbbell', 'At the gym'],
  sleeping: ['moon', 'Sleeping'], vacation: ['compass', 'On vacation'],
  grass: ['sprout', 'Touching grass'], doomscroll: ['phone', 'Doom-scrolling'],
  mainchar: ['star4', 'Main character mode'], lowbattery: ['battery', 'Social battery low'],
};
const SIG_META = { promise: ['flag', 'promise'], idea: ['bulb', 'idea'], decision: ['checkCircle', 'decision'], question: ['help', 'question'] };
// The Intent Engine, but make it honest
const INTENT_WORDS = { thinking: 'plotting…', writing: 'cooking…', reflecting: 'rethinking everything…', searching: 'digging…' };
const PLACEHOLDERS = [
  'send something crazy…', 'dedicate a song?', 'roast them…', 'spill the tea…',
  'say it with your chest…', 'type like nobody’s screenshotting…',
  'drop something unhinged… (try /confetti)', 'manifesting a reply…',
  'go on, double-text. be brave…', 'say something worth remembering…',
];
const TL_ICONS = { first_message: 'sprout', promise: 'flag', memory: 'star', idea: 'bulb', milestone: 'mountain' };
const ctxChip = key => { const c = CTX_META[key]; return c ? `${icon(c[0], 13)} ${c[1]}` : ''; };

// ------------------------------------------------------------- utilities -----
const $ = sel => document.querySelector(sel);
const app = () => $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const clock = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/** "3h 42m" until a deadline — for things that dissolve. */
const timeLeft = until => {
  const d = Math.max(0, until - Date.now());
  const h = Math.floor(d / 3600_000), m = Math.ceil((d % 3600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const initials = name => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

/** avatar_config arrives as a JSON string from the server (or already parsed). */
function parseAvatarConfig(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function avatarHtml(p, size = '', withDot = false) {
  const hue = p.avatar_hue ?? 210;
  const dot = withDot ? `<span class="dot ${p.online ? 'on' : ''}"></span>` : '';
  // Created avatar (layered SVG) > uploaded photo > pastel identity circle
  const cfg = parseAvatarConfig(p.avatar_config);
  const inner = cfg
    ? buildAvatar(cfg)
    : (p.avatar_url
      ? `<img class="av-img" src="${esc(p.avatar_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : esc(initials(p.display_name || p.username || '?')));
  return `<span class="avatar ${size}" style="--ah:${hue}">${inner}${dot}</span>`;
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.innerHTML = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/** On-brand icon picker for user-created things (spaces, personas, concepts). */
function pickerHtml(id, set, current) {
  return `<div class="icon-pick" id="${id}">${PICKS[set].map(n =>
    `<button type="button" data-ic="${n}" class="${n === current ? 'sel' : ''}" title="${n}">${icon(n, 17)}</button>`).join('')}</div>`;
}
function wirePicker(id, initial) {
  let val = initial;
  const el = document.getElementById(id);
  el?.querySelectorAll('[data-ic]').forEach(b => b.onclick = () => {
    el.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    val = b.dataset.ic;
  });
  return () => val;
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.token) return signOut();
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

// ------------------------------------------------- E2E sealed messages -------
// ECDH P-256 key agreement + AES-GCM, all WebCrypto, all on-device.
// The private key never leaves localStorage; the server only sees ciphertext.
const b64 = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

async function ensureKeys() {
  try {
    const store = 'aether_priv_' + S.me.id;
    let privJwk = JSON.parse(localStorage.getItem(store) || 'null');
    if (!privJwk) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      localStorage.setItem(store, JSON.stringify(privJwk));
    }
    S.privKey = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    // P-256 private JWKs carry the public coords — republish every boot so a
    // reset server DB heals itself.
    const pubJwk = { kty: privJwk.kty, crv: privJwk.crv, x: privJwk.x, y: privJwk.y };
    await api('/me/pubkey', { body: { publicKey: JSON.stringify(pubJwk) } });
  } catch (e) { console.warn('E2E unavailable:', e); }
}

const dmKeyCache = {};
async function dmKey(otherId, pubJwkStr) {
  if (dmKeyCache[otherId]) return dmKeyCache[otherId];
  const pub = await crypto.subtle.importKey('jwk', JSON.parse(pubJwkStr), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, S.privKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  dmKeyCache[otherId] = key;
  return key;
}

async function sealText(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ iv: b64.enc(iv), ct: b64.enc(ct) });
}
async function unsealText(body, key) {
  const { iv, ct } = JSON.parse(body);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv) }, key, b64.dec(ct));
  return new TextDecoder().decode(pt);
}

// ------------------------------------------------------------------ auth -----
function signOut() {
  api('/auth/logout', { body: {} }).catch(() => {}); // clear the /files session cookie
  localStorage.removeItem('aether_token');
  S.token = null; S.me = null;
  S.socket?.disconnect(); S.socket = null;
  location.hash = '';
  renderAuth();
}

/* ---- Supabase Auth (Milestone 3) — the identity provider seam.
   We speak GoTrue's REST API directly (no SDK, no build step): sign-up and
   sign-in happen against Supabase, then the access token is exchanged at
   /api/auth/supabase for a normal local Ikvizz session. */
let authCfgPromise = null;
const authConfig = () => (authCfgPromise ??= api('/auth/config').catch(() => ({})));

async function supabaseAuth(cfg, path, body) {
  const res = await fetch(cfg.url + '/auth/v1/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_code === 'email_not_confirmed'
      ? 'Confirm your email first — the link is in your inbox.'
      : data.error_code === 'invalid_credentials' ? 'Invalid email or password.'
      : data.msg || data.error_description || data.message || 'Supabase sign-in failed.';
    const e = new Error(msg); e.code = data.error_code; throw e;
  }
  return data;
}

/** Exchange a Supabase access token for a local Ikvizz session and boot. */
async function enterWithSupabase(accessToken) {
  const data = await api('/auth/supabase', { body: { accessToken } });
  S.token = data.token;
  localStorage.setItem('aether_token', data.token);
  await boot();
}

async function renderAuth(mode = 'login') {
  const isReg = mode === 'register';
  const cfg = await authConfig();
  const sb = cfg.supabase; // null → local-only auth, exactly as before
  app().innerHTML = `
  <div class="auth-wrap">
    <div class="card auth-card">
      <div class="auth-logo">${icon('aether', 44, 'accent')}</div>
      <h1>Ikvizz</h1>
      <p class="tagline">Communication should transfer understanding, not messages.</p>
      <form id="auth-form">
        ${isReg ? `<div class="field"><label>Your name</label><input class="input" name="displayName" placeholder="Aarav Sharma" /></div>` : ''}
        <div class="field"><label>${sb && !isReg ? 'Username or email' : 'Username'}</label><input class="input" name="username" autocomplete="username" placeholder="${sb && !isReg ? 'aarav — or you@example.com' : 'aarav'}" required /></div>
        ${isReg && sb ? `<div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" placeholder="you@example.com" required /></div>` : ''}
        ${isReg ? `<div class="field"><label>Phone <span class="faint">(optional — so friends can find you, like WhatsApp)</span></label><input class="input" name="phone" type="tel" autocomplete="tel" placeholder="+91 98765 43210" /></div>` : ''}
        <div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="••••••••" required /></div>
        <div class="auth-error" id="auth-error"></div>
        <button class="btn" style="width:100%">${isReg ? 'Create my universe' : 'Enter'}</button>
      </form>
      <div class="auth-or"><span>or</span></div>
      <button class="btn ghost g-btn" id="google-btn" type="button">
        <svg width="17" height="17" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6C12.3 13.4 17.7 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5Z"/><path fill="#FBBC05" d="M10.4 28.8a14.5 14.5 0 0 1 0-9.6l-7.8-6a24 24 0 0 0 0 21.6l7.8-6Z"/><path fill="#34A853" d="M24 48c6.1 0 11.6-2 15.4-5.5l-7.5-5.8c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.7-3.9-13.6-9.7l-7.8 6C6.5 42.6 14.6 48 24 48Z"/></svg>
        Continue with Google
      </button>
      <div id="gsi-slot" style="display:flex;justify-content:center;margin-top:8px"></div>
      <div class="auth-switch">${isReg ? 'Already here?' : 'New to Ikvizz?'} <a href="#" id="auth-switch">${isReg ? 'Sign in' : 'Create an account'}</a></div>
      <div class="demo-hint">${icon('sparkle', 14, 'accent')} Try the demo world: <code>aarav</code> / <code>aether123</code> (also: rahul, maya, amma, vikram)</div>
    </div>
  </div>`;
  $('#auth-switch').onclick = e => { e.preventDefault(); renderAuth(isReg ? 'login' : 'register'); };
  wireGoogleSignIn();
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = m => { $('#auth-error').textContent = m; };
    const localEnter = async () => {
      const data = await api(isReg ? '/auth/register' : '/auth/login', {
        body: { username: f.get('username'), password: f.get('password'), displayName: f.get('displayName'), phone: f.get('phone') },
      });
      S.token = data.token;
      localStorage.setItem('aether_token', data.token);
      await boot();
    };
    try {
      if (sb && isReg) {
        // Identity lives in Supabase; the username/name/phone travel as
        // metadata and become the Ikvizz profile on first sign-in.
        const uname = String(f.get('username') || '').trim().toLowerCase();
        if (!/^[a-z0-9_]{3,24}$/.test(uname)) return err('Username must be 3–24 chars: letters, numbers, underscore.');
        const d = await supabaseAuth(sb, 'signup', {
          email: f.get('email'), password: f.get('password'),
          data: { username: uname, full_name: f.get('displayName') || uname, phone: f.get('phone') || undefined },
        });
        if (d.access_token) return enterWithSupabase(d.access_token);
        if (d.id || d.user) {
          const u = d.user || d;
          if (Array.isArray(u.identities) && u.identities.length === 0)
            return err('That email already has an account — sign in instead.');
          return err('Almost there — confirm the link we just emailed you, then sign in.');
        }
        return err('Sign-up did not complete — try again.');
      }
      if (sb && !isReg && String(f.get('username') || '').includes('@')) {
        // Email → Supabase; if that account predates Supabase, fall back local
        try {
          const d = await supabaseAuth(sb, 'token?grant_type=password', {
            email: String(f.get('username')).trim(), password: f.get('password'),
          });
          return enterWithSupabase(d.access_token);
        } catch (e2) {
          if (e2.code === 'email_not_confirmed') throw e2;
          return localEnter().catch(() => err(e2.message));
        }
      }
      await localEnter();
    } catch (e3) { err(e3.message); }
  };
}

/* Sign in with Google — real GIS flow when the server has a client id;
   an honest explainer when it doesn't. */
async function wireGoogleSignIn() {
  const btn = $('#google-btn');
  if (!btn) return;
  const cfg = await authConfig();
  if (!cfg.googleClientId) {
    btn.onclick = () => toast(
      `${icon('help', 14, 'accent')} Google sign-in is wired but needs a (free) client ID: create one at console.cloud.google.com → OAuth credentials, then start the server with GOOGLE_CLIENT_ID=… — the button goes live instantly.`,
    );
    return;
  }
  // Load Google Identity Services once, then use the official flow
  if (!window.google?.accounts) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).catch(() => null);
  }
  if (!window.google?.accounts) { btn.onclick = () => toast('Could not reach Google right now.', true); return; }
  window.google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: async resp => {
      try {
        const data = await api('/auth/google', { body: { credential: resp.credential } });
        S.token = data.token;
        localStorage.setItem('aether_token', data.token);
        await boot();
      } catch (e) { const el = $('#auth-error'); if (el) el.textContent = e.message; }
    },
  });
  btn.style.display = 'none'; // swap our placeholder for Google's official button
  window.google.accounts.id.renderButton($('#gsi-slot'), { theme: 'outline', size: 'large', shape: 'pill', width: 300 });
}

// ------------------------------------------------------------------ boot -----
async function boot() {
  if (!S.token) return renderAuth();
  try {
    const meData = await api('/me');
    S.me = meData.user; S.personas = meData.personas; S.contexts = meData.contexts;
  } catch { return; /* 401 path already signed out */ }
  connectSocket();
  ensureKeys(); // E2E keypair — non-blocking, heals itself on every boot
  await refreshPeople();
  api('/notifications').then(d => { S.notifUnread = d.unread; updateBadges(); }).catch(() => {});
  initPush(false); // resubscribe silently if permission was already granted
  renderShell();
  route();
}

/* ---- Web Push (Phase 9) — real background notifications, no Apple/APNs ---- */
const urlB64ToU8 = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

async function initPush(interactive) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (interactive) toast('Background push is not supported in this browser.', true);
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission !== 'granted') {
      if (!interactive) return false;
      if (await Notification.requestPermission() !== 'granted') return false;
    }
    const { key } = await api('/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
    await api('/push/subscribe', { body: { subscription: sub.toJSON() } });
    S.pushOn = true;
    return true;
  } catch (e) {
    if (interactive) toast('Could not enable push: ' + esc(e.message), true);
    return false;
  }
}

async function refreshPeople() {
  const d = await api('/people');
  S.people = d.people; S.relKinds = d.kinds;
}

function totalUnread() { return S.people.reduce((n, p) => n + p.unread, 0); }

// ---------------------------------------------------------------- socket -----
function connectSocket() {
  S.socket?.disconnect();
  const socket = io({ auth: { token: S.token } });
  S.socket = socket;

  socket.on('message:new', ({ conversationId, message }) => {
    if (S.chat?.conversationId === conversationId) {
      const stick = message.sender.id === S.me.id || msgsNearBottom();
      S.chat.messages.push(message);
      appendMessage(message, stick);
      setIntent(message.sender.id, null);
      renderSmartReplies();
      updateVibeMeter();
      const fx = (message.signals || []).find(s => s.type === 'effect');
      if (fx) runEffect(fx.kind);
      if (message.sender.id !== S.me.id) {
        if (stick) socket.emit('conversation:read', conversationId);
        else {
          S.chat.unseenBelow++;
          const pill = $('#scroll-pill'), cnt = $('#pill-count');
          if (pill) pill.hidden = false;
          if (cnt) cnt.textContent = `${S.chat.unseenBelow} new`;
        }
      }
    }
  });

  socket.on('reaction:update', ({ conversationId, messageId, reactions }) => {
    if (S.chat?.conversationId !== conversationId) return;
    const m = S.chat.messages.find(x => x.id === messageId);
    if (m) { m.reactions = reactions; refreshMessageNode(m); }
  });

  socket.on('message:edited', ({ conversationId, message }) => {
    if (S.chat?.conversationId !== conversationId) return;
    const m = S.chat.messages.find(x => x.id === message.id);
    if (m) {
      Object.assign(m, { body: message.body, priority: message.priority, signals: message.signals, edited_at: message.edited_at });
      refreshMessageNode(m);
      renderSmartReplies();
    }
  });

  socket.on('message:deleted', ({ conversationId, messageId }) => {
    if (S.chat?.conversationId !== conversationId) return;
    const m = S.chat.messages.find(x => x.id === messageId);
    if (m) {
      m.deleted = 1; m.body = ''; m.attachment = null; m.reactions = [];
      refreshMessageNode(m);
      renderSmartReplies();
    }
  });

  wireCallSignals(socket);
  wireMusicSync(socket);

  socket.on('poll:update', ({ conversationId, messageId, votes }) => {
    if (S.chat?.conversationId !== conversationId) return;
    const m = S.chat.messages.find(x => x.id === messageId);
    if (m) { m.votes = { ...votes, mine: m.votes?.mine ?? null }; refreshMessageNode(m); }
  });

  socket.on('viewonce:opened', ({ conversationId, messageId }) => {
    if (S.chat?.conversationId !== conversationId) return;
    markViewOnceOpened(messageId);
  });

  socket.on('read', ({ conversationId, userId, lastReadId }) => {
    if (S.chat?.conversationId !== conversationId || userId === S.me.id) return;
    S.chat.othersReadTo = Math.max(S.chat.othersReadTo, lastReadId);
    updateSeen();
  });

  // Priority Streams: only critical/important (or a direct @mention) interrupt.
  socket.on('inbox:update', async ({ conversationId, priority, mentioned, from, preview }) => {
    await refreshPeople().catch(() => {});
    updateBadges();
    if (S.view?.name === 'people') renderPeople();
    if (S.view?.name === 'today') renderToday();
    const interrupts = mentioned || priority === 'critical' || priority === 'important';
    if (S.chat?.conversationId !== conversationId && interrupts) {
      const p = S.people.find(x => x.conversation_id === conversationId);
      if (p?.muted) return;
      const who = p?.display_name || from || 'Someone';
      toast(mentioned
        ? `${icon('message', 15, 'accent')} <b>${esc(who)}</b> mentioned you`
        : `${icon('alert', 15, priority === 'critical' ? 'critical' : 'important')} <b>${esc(who)}</b> — ${priority} message`);
      // Browser push when the tab is in the background
      if (document.hidden && 'Notification' in window) {
        if (Notification.permission === 'default') Notification.requestPermission();
        if (Notification.permission === 'granted') {
          new Notification(mentioned ? `${who} mentioned you` : `${who} · ${priority}`, { body: preview || '', silent: priority !== 'critical' });
        }
      }
    }
  });

  socket.on('intent', ({ conversationId, userId, intent }) => {
    if (S.chat?.conversationId === conversationId) setIntent(userId, intent);
  });

  socket.on('presence', ({ userId, online }) => {
    const p = S.people.find(x => x.other_id === userId);
    if (p) p.online = online;
    if (S.view?.name === 'people') renderPeople();
    if (S.chat?.other?.other_id === userId) renderChatHead();
  });

  socket.on('context', ({ userId, context, context_note }) => {
    const p = S.people.find(x => x.other_id === userId);
    if (p) { p.context = context; p.context_note = context_note; }
    if (S.view?.name === 'people') renderPeople();
    if (S.chat?.other?.other_id === userId) { S.chat.other.context = context; S.chat.other.context_note = context_note; renderChatHead(); }
  });

  // Notification center (Phase 9): the quiet record, live
  socket.on('notify', n => {
    S.notifUnread = (S.notifUnread || 0) + 1;
    updateBadges();
    if (S.view?.name === 'alerts') renderAlerts();
    const ic = { mention: 'message', reaction: 'smile', call: 'call', story: 'sun', moodsync: 'orbit', roast: 'flame', rizz: 'zap' }[n.kind] || 'bell';
    toast(`${icon(ic, 14, 'accent')} ${esc(n.title)}`);
  });

  // Group calls (Phase 7): live participant counts on space chats
  socket.on('call:room:state', ({ conversationId, count }) => {
    S.roomCalls = S.roomCalls || {};
    S.roomCalls[conversationId] = count;
    if (S.chat?.conversationId === conversationId && S.chat.spaceMeta) renderChatHead();
  });
  wireGroupCallSignals(socket);
}

// ---------------------------------------------------------------- router -----
window.addEventListener('hashchange', route);

function route() {
  if (!S.me) return;
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, arg] = hash.split('/');
  if (S.chat && name !== 'chat') { S.socket?.emit('conversation:leave', S.chat.conversationId); S.chat = null; }
  S.view = { name: name || WORLDS[S.world].home, arg };
  // Disabled worlds are unreachable, even by direct URL
  if ((S.view.name === 'edu' && !worldEnabled('edu')) || (S.view.name === 'life' && !worldEnabled('life'))) {
    S.view = { name: 'today' };
    if (location.hash !== '#/today') { go('/today'); return; }
  }
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === S.view.name || (name === 'chat' && b.dataset.nav === 'people') || (name === 'space' && b.dataset.nav === 'spaces')));
  // Invite links: aether/#/add/<username> lands here and pre-fills Add person
  if (S.view.name === 'add' && arg) {
    S.pendingAdd = decodeURIComponent(arg);
    go('/people');
    return;
  }
  const views = {
    today: renderToday, people: renderPeople, chat: () => openChat(Number(arg)),
    spaces: renderSpaces, space: () => renderSpaceDetail(Number(arg)),
    memory: renderMemory, me: renderMe, alerts: renderAlerts, confessions: renderConfessions,
    edu: renderEdu, life: renderLife, horizon: renderHorizon,
  };
  (views[S.view.name] || renderToday)();
}

const go = h => { location.hash = h; };

// ----------------------------------------------------------------- shell -----
// One core intelligence, several worlds. Only the presentation changes.
// Feature flags: worlds listed here are fully hidden from users.
// To re-launch a world later, just remove it from this list.
const DISABLED_WORLDS = ['edu', 'life'];
const worldEnabled = k => !DISABLED_WORLDS.includes(k);

const WORLDS = {
  now:     { label: 'NOW',     ic: 'aether', home: 'today',   nav: [['today', 'sun', 'Today'], ['people', 'orbit', 'People'], ['spaces', 'rocket', 'Spaces'], ['confessions', 'moon', 'Confessions'], ['memory', 'db', 'Memory']] },
  edu:     { label: 'EDU',     ic: 'grad',   home: 'edu',     nav: [['edu', 'planet', 'Universe'], ['spaces', 'rocket', 'Team Spaces'], ['today', 'sun', 'Today'], ['memory', 'db', 'Memory']] },
  life:    { label: 'LIFE',    ic: 'home',   home: 'life',    nav: [['life', 'home', 'Home'], ['today', 'sun', 'Today'], ['people', 'users', 'People'], ['memory', 'db', 'Memory']] },
  horizon: { label: 'HORIZON', ic: 'star4',  home: 'horizon', nav: [['horizon', 'star4', 'Universe'], ['today', 'sun', 'Today']] },
};

function setWorld(w) {
  S.world = w;
  localStorage.setItem('aether_world', w);
  renderShell();
  const home = '/' + WORLDS[w].home;
  if (location.hash === '#' + home) route(); else go(home);
}

function renderShell() {
  const ctx = CTX_META[S.me.context] || CTX_META.available;
  const world = WORLDS[S.world];
  app().innerHTML = `
  <div class="shell">
    <nav class="rail">
      <div class="logo">${icon('aether', 21, 'accent')}<b>Ikvizz</b></div>
      <div class="world-switch" style="grid-template-columns:repeat(${Object.keys(WORLDS).filter(worldEnabled).length},1fr)">
        ${Object.entries(WORLDS).filter(([k]) => worldEnabled(k)).map(([k, w]) => `<button class="ws ${k === S.world ? 'active' : ''}" data-world="${k}" title="Ikvizz ${w.label}">${icon(w.ic, 17)}<small>${w.label}</small></button>`).join('')}
      </div>
      <button class="rail-search" id="rail-search" title="Search everything (Ctrl+K)">${icon('search', 15)}<span>Search…</span><kbd>⌘K</kbd></button>
      ${world.nav.map(([key, ico, lbl]) => `
        <button class="nav-item" data-nav="${key}"><span class="ico">${icon(ico, 18)}</span><span class="lbl">${lbl}</span>${key === 'people' ? '<span class="badge" id="unread-badge" style="display:none"></span>' : ''}</button>`).join('')}
      <button class="nav-item" data-nav="alerts"><span class="ico">${icon('bell', 18)}</span><span class="lbl">Alerts</span><span class="badge" id="notif-badge" style="display:none"></span></button>
      <div class="spacer"></div>
      <div class="kbd-hint"><kbd>Ctrl</kbd>+<kbd>K</kbd> search everything</div>
      <div class="me-card" data-nav="me">
        ${avatarHtml(S.me)}
        <div class="who"><div class="nm">${esc(S.me.display_name)}</div><div class="ctx" id="me-ctx">${icon(ctx[0], 12)} ${ctx[1]}</div></div>
      </div>
    </nav>
    <main class="main" id="main"></main>
  </div>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go('/' + b.dataset.nav));
  document.querySelectorAll('[data-world]').forEach(b => b.onclick = () => setWorld(b.dataset.world));
  $('#rail-search').onclick = () => togglePalette(true);
  updateBadges();
}

function updateBadges() {
  const n = totalUnread();
  const b = $('#unread-badge');
  if (b) { b.style.display = n ? '' : 'none'; b.textContent = n > 99 ? '99+' : n; }
  const nb = $('#notif-badge'), nn = S.notifUnread || 0;
  if (nb) { nb.style.display = nn ? '' : 'none'; nb.textContent = nn > 99 ? '99+' : nn; }
  const mc = $('#me-ctx');
  if (mc && S.me) { const c = CTX_META[S.me.context] || CTX_META.available; mc.innerHTML = `${icon(c[0], 12)} ${c[1]}`; }
}

/* ---- notification center (Phase 9) — the quiet, honest record --------------- */
async function renderAlerts() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="alerts-page"><div class="empty">Gathering what happened…</div></div></div>`;
  const d = await api('/notifications').catch(() => ({ notifications: [], unread: 0 }));
  if (S.view?.name !== 'alerts') return;
  const NK = { mention: ['message', 'mention'], reaction: ['smile', 'reaction'], call: ['call', 'call'], story: ['sun', 'moment'], moodsync: ['orbit', 'moodsync'], roast: ['flame', 'roast'], rizz: ['zap', 'rizz battle'] };
  $('#alerts-page').innerHTML = `
    <h2>Alerts</h2>
    <div class="sub">Mentions, reactions, calls and moments — recorded quietly. Priority Streams still decide what interrupts.</div>
    ${!S.pushOn && Notification?.permission !== 'granted' ? `
      <div class="card" style="margin-bottom:14px;display:flex;gap:10px;align-items:center">
        ${icon('bell', 18, 'accent')}
        <div style="flex:1">Get these even when Ikvizz is closed — real background push (Chrome, Edge, Firefox, Android).</div>
        <button class="btn small" id="push-on">Enable push</button>
      </div>` : ''}
    <div id="alert-list">
      ${d.notifications.map(n => {
        const [ic, k] = NK[n.kind] || ['bell', n.kind];
        return `<div class="brief-item ${n.read ? '' : 'unread-alert'}" data-ndata='${esc(JSON.stringify(n.data || {}))}'>
          ${icon(ic, 17, n.read ? 'dim' : 'accent')}
          <div class="txt"><div class="t">${esc(n.title)}</div>
          <div class="m">${n.body ? esc(n.body) + ' · ' : ''}${k} · ${timeAgo(n.created_at)} ago</div></div>
        </div>`;
      }).join('') || `<div class="empty"><span class="big">${icon('bell', 32, 'dim')}</span>All quiet. That's the point.</div>`}
    </div>`;
  $('#push-on') && ($('#push-on').onclick = async () => { if (await initPush(true)) { toast(`${icon('bell', 14, 'accent')} Background push is on.`); renderAlerts(); } });
  $('#alerts-page').querySelectorAll('[data-ndata]').forEach(el => el.onclick = () => {
    const data = JSON.parse(el.dataset.ndata || '{}');
    if (data.conversationId) go('/chat/' + data.conversationId);
    else if (data.spaceId) go('/space/' + data.spaceId);
    else if (data.userId) go('/people');
  });
  if (d.unread) {
    await api('/notifications/read', { body: {} }).catch(() => {});
    S.notifUnread = 0;
    updateBadges();
  }
}

// ============================================================================
// Late Night Confession Train — post anonymously, ride the train, reply by
// voice or text. Author identity never leaves the server. 100% free.
// ============================================================================
async function renderConfessions() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="cf-page"><div class="empty">Boarding the train…</div></div></div>`;
  if (S.view?.name !== 'confessions') return;
  const hour = new Date().getHours();
  const lateNight = hour >= 0 && hour < 5;
  $('#cf-page').innerHTML = `
    <h2>Confession Train</h2>
    <div class="sub">${lateNight ? 'It’s the witching hour. Perfect.' : 'Anonymous, always. Post a secret — it rides to strangers who reply. Gone in 24h.'}</div>
    <div class="card" style="margin-bottom:16px">
      <textarea class="input" id="cf-body" rows="3" placeholder="say the thing you can't say with your name on it…" maxlength="800"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <div class="faint" style="flex:1">no usernames, no traces — just the vibe</div>
        <button class="btn" id="cf-post">${icon('send', 14)} Send it into the night</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn ghost small" id="cf-mode-ride" data-on="1">${icon('orbit', 13)} Ride the train</button>
      <button class="btn ghost small" id="cf-mode-mine">${icon('moon', 13)} My confessions</button>
    </div>
    <div id="cf-stream"></div>`;
  $('#cf-post').onclick = async () => {
    const body = $('#cf-body').value.trim();
    if (body.length < 3) return toast('Say a little more.', true);
    try {
      await api('/confessions', { body: { body } });
      $('#cf-body').value = '';
      toast(`${icon('moon', 14, 'accent')} Off it goes. Someone out there will find it.`);
    } catch (e) { toast(esc(e.message), true); }
  };
  const modeRide = $('#cf-mode-ride'), modeMine = $('#cf-mode-mine');
  modeRide.onclick = () => { modeRide.classList.add('on'); modeMine.classList.remove('on'); cfRide(); };
  modeMine.onclick = () => { modeMine.classList.add('on'); modeRide.classList.remove('on'); cfMine(); };
  modeRide.classList.add('on');
  cfRide();
}

function cfCard(c, { showReply }) {
  const m = MOODS[c.mood];
  return `
  <div class="card cf-card" data-cf="${c.id}">
    <div class="cf-head">${m ? mood(c.mood, 22) : icon('moon', 18, 'dim')}<b>${esc(c.author)}</b><span class="faint">${timeAgo(c.created_at)} ago</span></div>
    <div class="cf-body-text">${esc(c.body)}</div>
    <div class="cf-replies">${(c.replies || []).map(r => `
      <div class="cf-reply">
        <b>${esc(r.author)}</b>
        ${r.attachment ? audioHtml(r.attachment.url) : ''}
        ${r.body ? `<span>${esc(r.body)}</span>` : ''}
      </div>`).join('')}</div>
    ${showReply ? `
    <div class="cf-reply-box">
      <input class="input" id="cf-r-${c.id}" placeholder="reply anonymously…" maxlength="500"/>
      <button class="btn ghost small" data-cf-voice="${c.id}" title="Voice reply">${icon('mic', 15)}</button>
      <button class="btn small" data-cf-send="${c.id}">${icon('send', 13)}</button>
    </div>` : ''}
  </div>`;
}

async function cfRide() {
  const box = $('#cf-stream');
  if (!box) return;
  box.innerHTML = `<div class="empty">Finding a confession for you…</div>`;
  const d = await api('/confessions/next').catch(() => null);
  if (!box || S.view?.name !== 'confessions') return;
  if (!d?.confession) {
    box.innerHTML = `<div class="empty"><span class="big">${icon('moon', 32, 'dim')}</span>${d?.waiting ? 'You’ve seen every confession on the train right now. Check back later.' : 'The train is empty. Be the first — post a confession above.'}</div>`;
    return;
  }
  box.innerHTML = cfCard(d.confession, { showReply: true }) +
    `<div style="text-align:center;margin-top:14px"><button class="btn ghost" id="cf-next">${icon('forward', 14)} Next confession</button></div>`;
  $('#cf-next').onclick = cfRide;
  wireCfReply(d.confession.id, cfRide);
  wireAudio(box);
}

async function cfMine() {
  const box = $('#cf-stream');
  if (!box) return;
  box.innerHTML = `<div class="empty">Loading your confessions…</div>`;
  const d = await api('/confessions/mine').catch(() => ({ confessions: [] }));
  if (!box || S.view?.name !== 'confessions') return;
  box.innerHTML = d.confessions.length
    ? d.confessions.map(c => cfCard(c, { showReply: false })).join('')
    : `<div class="empty"><span class="big">${icon('moon', 32, 'dim')}</span>You haven't confessed anything yet. Your secrets are safe… too safe.</div>`;
  wireAudio(box);
}

function wireCfReply(id, after) {
  const send = async (attachment) => {
    const input = $(`#cf-r-${id}`);
    const body = input?.value.trim() || '';
    if (!body && !attachment) return;
    try {
      await api(`/confessions/${id}/reply`, { body: { body, attachment } });
      if (input) input.value = '';
      toast(`${icon('moon', 14, 'accent')} Reply sent, anonymously.`);
      after && after();
    } catch (e) { toast(esc(e.message), true); }
  };
  $(`[data-cf-send="${id}"]`)?.addEventListener('click', () => send(null));
  $(`#cf-r-${id}`)?.addEventListener('keydown', e => { if (e.key === 'Enter') send(null); });
  $(`[data-cf-voice="${id}"]`)?.addEventListener('click', () => recordConfessionVoice(id, send));
}

// Record a short voice reply using the same MediaRecorder path as voice notes.
async function recordConfessionVoice(id, send) {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone not available.', true);
  const btn = $(`[data-cf-voice="${id}"]`);
  if (btn?.dataset.rec) { window._cfStop?.(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream); const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (btn) { delete btn.dataset.rec; btn.classList.remove('rec'); btn.innerHTML = icon('mic', 15); }
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1200) return;
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
      const att = await api('/upload', { body: { name: `confession-voice.${ext}`, type: blob.type.split(';')[0], dataBase64: String(dataUrl).split(',')[1] } }).catch(e => (toast(esc(e.message), true), null));
      if (att) send(att);
    };
    rec.start();
    if (btn) { btn.dataset.rec = '1'; btn.classList.add('rec'); btn.innerHTML = icon('stop', 15); }
    window._cfStop = () => rec.state === 'recording' && rec.stop();
    toast(`${icon('mic', 14, 'critical')} Recording… tap again to send.`);
  } catch { toast('Microphone permission denied.', true); }
}

const main = () => $('#main');

// ------------------------------------------------------------ today view -----
async function renderToday() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="today"><div class="empty">Reading your relationships…</div></div></div>`;
  const b = await api('/briefing').catch(() => null);
  if (!b || S.view.name !== 'today') return;

  const hour = new Date().getHours();
  const greet = hour < 5 ? 'still up? iconic' : hour < 12 ? 'good morning' : hour < 17 ? 'good afternoon' : 'good evening';
  const bestStreak = Math.max(0, ...S.people.map(p => p.streak || 0));

  const promiseRow = (p, who, dir) => {
    const daysOld = Math.floor((Date.now() - p.created_at) / 86_400_000);
    const late = daysOld >= 2 ? `<span class="chip critical" style="font-size:10px;padding:0 7px">${daysOld}d and counting</span> · ` : '';
    return `
    <div class="brief-item" data-promise="${p.id}">
      ${icon('flag', 16, daysOld >= 2 ? 'critical' : 'important')}
      <div class="txt"><div class="t">${esc(p.body)}</div>
      <div class="m">${late}${dir} <b>${esc(who || 'someone')}</b>${p.due_hint ? ` · due ${esc(p.due_hint)}` : ''} · made ${timeAgo(p.created_at)} ago</div></div>
      ${dir === 'to' ? `<button class="btn ghost small act" data-keep="${p.id}">${icon('check', 13)} Kept</button>` : ''}
    </div>`;
  };

  $('#today').innerHTML = `
    <div class="memory-sphere"><div class="orb"></div><div class="cap">your world is synced.</div></div>
    <div class="hero-card">
      <div class="hero-greet">${greet}, <span class="grad-text">${esc(S.me.display_name.split(' ')[0].toLowerCase())}</span>.</div>
      <div class="hero-sub">here's what your people need from you — not your notifications.</div>
      <div class="hero-band">
        <div><b>${b.myPromises.length}</b><span>promises to keep</span></div>
        <div><b>${b.waiting.length}</b><span>waiting on you</span></div>
        <div><b>${b.ideas.length}</b><span>ideas simmering</span></div>
        ${bestStreak >= 2 ? `<div><b>${bestStreak}${icon('flame', 15)}</b><span>best streak</span></div>` : `<div><b>${b.memories.length}</b><span>memories kept</span></div>`}
      </div>
    </div>
    <div class="brief-grid">
      ${b.waiting.length ? `<div class="card brief-card"><h3>${icon('message', 15)} Conversations waiting</h3>${b.waiting.map(w => `
        <div class="brief-item" data-chat="${w.conversation_id}">
          ${avatarHtml({ display_name: w.other_name, avatar_hue: w.avatar_hue }, 'sm')}
          <div class="txt"><div class="t"><b>${esc(w.other_name)}</b> — ${esc(w.body)}</div>
          <div class="m">${w.priority !== 'normal' ? `<span class="chip ${w.priority}" style="font-size:10.5px;padding:1px 8px">${w.priority}</span> · ` : ''}${timeAgo(w.created_at)} ago</div></div>
        </div>`).join('')}</div>` : ''}
      ${b.myPromises.length ? `<div class="card brief-card"><h3>${icon('flag', 15)} Promises you made</h3>${b.myPromises.map(p => promiseRow(p, p.to_name, 'to')).join('')}</div>` : ''}
      ${b.owedToMe.length ? `<div class="card brief-card"><h3>${icon('link', 15)} Promised to you</h3>${b.owedToMe.map(p => promiseRow(p, p.from_name, 'by')).join('')}</div>` : ''}
      ${b.ideas.length ? `<div class="card brief-card"><h3>${icon('bulb', 15)} Ideas worth revisiting</h3>${b.ideas.map(i => `
        <div class="brief-item">${icon('bulb', 16, 'dim')}<div class="txt"><div class="t">${esc(i.body)}</div><div class="m">${esc(i.from_name)} · ${timeAgo(i.created_at)} ago</div></div></div>`).join('')}</div>` : ''}
      ${b.openTasks.length ? `<div class="card brief-card"><h3>${icon('checkCircle', 15)} Open in your spaces</h3>${b.openTasks.map(t => `
        <div class="brief-item" data-space="${t.space_id}">${icon(t.space_emoji, 16, 'dim')}<div class="txt"><div class="t">${esc(t.title)}</div><div class="m">${esc(t.space_name)}</div></div></div>`).join('')}</div>` : ''}
      ${worldEnabled('life') && b.lifeDue?.length ? `<div class="card brief-card"><h3>${icon('home', 15)} Due in your life</h3>${b.lifeDue.map(t => `
        <div class="brief-item" data-life="${t.room}">${icon('clock', 16, t.due_at < Date.now() ? 'critical' : 'important')}<div class="txt"><div class="t">${esc(t.title)}</div><div class="m">${esc(t.room)} · ${t.due_at < Date.now() ? 'overdue' : 'due ' + timeAgo(2 * Date.now() - t.due_at).replace('now', 'soon')}</div></div></div>`).join('')}</div>` : ''}
      ${worldEnabled('edu') && b.assignmentsDue?.length ? `<div class="card brief-card"><h3>${icon('timer', 15)} Assignments landing</h3>${b.assignmentsDue.map(a => `
        <div class="brief-item" data-edu="1">${icon('timer', 16, a.due_at < Date.now() ? 'critical' : 'important')}<div class="txt"><div class="t">${esc(a.title)}</div><div class="m">${a.concept_name ? esc(a.concept_name) + ' · ' : ''}${a.due_at < Date.now() ? 'overdue' : 'due soon'}</div></div></div>`).join('')}</div>` : ''}
      ${worldEnabled('edu') && b.reviewConcepts?.length ? `<div class="card brief-card"><h3>${icon('planet', 15)} Knowledge fading</h3>${b.reviewConcepts.map(c => `
        <div class="brief-item" data-edu="1">${icon(c.emoji, 16, 'dim')}<div class="txt"><div class="t">${esc(c.name)} has dimmed to ${c.effective}%</div><div class="m">a short review restores it</div></div></div>`).join('')}</div>` : ''}
      ${b.drifting?.length ? `<div class="card brief-card"><h3>${icon('heart', 15)} Drifting — reconnect?</h3>${b.drifting.map(d => `
        <div class="brief-item" data-chat="${d.conversation_id}">
          ${avatarHtml({ display_name: d.display_name, avatar_hue: d.avatar_hue }, 'sm')}
          <div class="txt"><div class="t"><b>${esc(d.display_name)}</b> — ${d.daysSilent} days of silence</div>
          <div class="m">${esc(d.kind)} · no pressure, but good ones are worth keeping</div></div>
          <button class="btn ghost small act">say hi</button>
        </div>`).join('')}</div>` : ''}
      ${b.memories.length ? `<div class="card brief-card"><h3>${icon('star', 15)} Recent memories</h3>${b.memories.map(m => `
        <div class="brief-item">${icon('star', 16, 'dim')}<div class="txt"><div class="t">${esc(m.body)}</div>${m.note ? `<div class="m">${esc(m.note)}</div>` : ''}</div></div>`).join('')}</div>` : ''}
    </div>`;

  // The Pearl is the semantic-search portal — tap it to search everything.
  const orb = $('#today .memory-sphere .orb');
  if (orb) { orb.title = 'Search everything'; orb.onclick = () => togglePalette(true); }
  $('#today').querySelectorAll('[data-chat]').forEach(el => el.onclick = () => go('/chat/' + el.dataset.chat));
  $('#today').querySelectorAll('[data-space]').forEach(el => el.onclick = () => go('/space/' + el.dataset.space));
  $('#today').querySelectorAll('[data-life]').forEach(el => el.onclick = () => { S.lifeRoom = el.dataset.life; go('/life'); });
  $('#today').querySelectorAll('[data-edu]').forEach(el => el.onclick = () => go('/edu'));
  $('#today').querySelectorAll('[data-keep]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await api('/promises/' + el.dataset.keep, { method: 'PATCH', body: { status: 'kept' } });
    toast(`${icon('flag', 15, 'ok')} Promise kept. The timeline remembers.`);
    renderToday();
  });
}

// ----------------------------------------------------------- people view -----
function renderPeople() {
  if (S.view?.name !== 'people') return;
  const sorted = [...S.people].sort((a, b) => {
    const prio = m => m?.priority === 'critical' ? 0 : m?.priority === 'important' ? 1 : 2;
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1; // pinned float to the top
    if (!!b.unread !== !!a.unread) return b.unread ? 1 : -1;
    if (a.unread && b.unread && prio(a.last_message) !== prio(b.last_message)) return prio(a.last_message) - prio(b.last_message);
    return (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0);
  });

  main().innerHTML = `
  <div class="page"><div class="page-narrow">
    <h2>People</h2>
    <div class="sub">Your relationship graph — not a contact list.</div>
    <div class="people-toolbar">
      <input class="input" id="people-filter" placeholder="Find your people…" />
      <div class="view-toggle">
        <button data-pv="bubbles" class="${S.peopleView === 'bubbles' ? 'active' : ''}">Bubbles</button>
        <button data-pv="list" class="${S.peopleView === 'list' ? 'active' : ''}">List</button>
        <button data-pv="map" class="${S.peopleView === 'map' ? 'active' : ''}">Constellation</button>
      </div>
    </div>
    <div id="moments"></div>
    <div class="filter-pills" id="people-pills">
      ${[['all', 'everyone'], ['unread', 'waiting on you'], ['inner', 'inner circle'], ['streak', 'streaks']].map(([k, l]) =>
        `<button data-pill="${k}" class="${(S.peoplePill || 'all') === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div id="people-body"></div>
    <button class="fab" id="add-person" title="Add a person">${icon('plus', 22)}</button>
  </div></div>`;

  document.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => {
    S.peopleView = b.dataset.pv; localStorage.setItem('aether_people_view', b.dataset.pv); renderPeople();
  });
  document.querySelectorAll('[data-pill]').forEach(b => b.onclick = () => { S.peoplePill = b.dataset.pill; renderPeople(); });
  $('#add-person').onclick = showAddPerson;
  $('#people-filter').oninput = e => drawPeopleBody(sorted, e.target.value);
  drawPeopleBody(sorted, '');
  if (S.pendingAdd) { const u = S.pendingAdd; S.pendingAdd = null; showAddPerson(u); }
  renderMoments();
}

/* ============================================================================
   Moments — stories the Ikvizz way. 24 hours, scoped, then gone forever.
   ============================================================================ */
async function renderMoments() {
  const rail = $('#moments');
  if (!rail) return;
  const d = await api('/stories').catch(() => null);
  if (!d || !$('#moments')) return;
  const mine = d.groups.find(g => g.user_id === d.me);
  rail.innerHTML = `<div class="moments-rail">
    <button class="moment-bubble" id="moment-add">
      <span class="p-bubble-av ${mine && !mine.allSeen ? '' : ''}">${avatarHtml(S.me, 'lg')}<span class="moment-plus">${icon('plus', 13)}</span></span>
      <b>your moment</b>
    </button>
    ${d.groups.filter(g => g.user_id !== d.me || g.stories.length).map(g => g.user_id === d.me ? '' : `
      <button class="moment-bubble ${g.allSeen ? 'seen' : 'unseen'}" data-mview="${g.user_id}">
        <span class="p-bubble-av">${avatarHtml(g, 'lg')}</span>
        <b>${esc(g.display_name.split(' ')[0])}</b>
      </button>`).join('')}
  </div>`;
  $('#moment-add').onclick = () => showMomentComposer(mine);
  rail.querySelectorAll('[data-mview]').forEach(b => b.onclick = () => showMomentViewer(d.groups, Number(b.dataset.mview)));
  if (mine?.stories.length) $('#moment-add').ondblclick = () => showMomentViewer(d.groups, d.me);
}

function showMomentComposer(mine) {
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="mo-veil"><div class="palette" style="padding:18px 20px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px">${icon('sun', 17, 'accent')}<b>Drop a moment</b>
      <span class="faint" style="flex:1">gone in 24h</span>
      <button class="btn ghost small" id="mo-close">${icon('x', 12)}</button></div>
    <textarea class="input" id="mo-text" rows="3" placeholder="what's the moment?"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
      <input type="file" id="mo-file" accept="image/*,video/*,audio/*" hidden />
      <button class="btn ghost small" id="mo-img" title="photo, video clip, or a song (mp3)">${icon('camera', 14)} <span id="mo-img-name">photo · video · music</span></button>
      <button class="btn ghost small" id="mo-voice" title="record a voice moment">${icon('mic', 14)} <span id="mo-voice-lbl">voice</span></button>
      <select class="input" id="mo-scope" style="max-width:180px">
        <option value="all">everyone I know</option>
        <option value="inner">inner circle only</option>
      </select>
      <button class="btn small" id="mo-post" style="margin-left:auto">${icon('send', 13)} Post</button>
    </div>
    ${mine?.stories.length ? `<div class="section-title">your live moments</div>${mine.stories.map(s => `
      <div class="brief-item">${icon({ image: 'image', video: 'video', voice: 'mic', music: 'music' }[s.kind] || 'message', 14, 'dim')}
        <div class="txt"><div class="t">${esc(s.body || s.attachment?.name || '')}</div><div class="m">${s.views} view${s.views === 1 ? '' : 's'} · ${timeAgo(s.created_at)} ago</div></div>
        <button class="btn ghost small" data-mo-del="${s.id}">${icon('trash', 12)}</button>
      </div>`).join('')}` : ''}
  </div></div>`;
  $('#mo-close').onclick = close;
  $('#mo-veil').onmousedown = e => { if (e.target.id === 'mo-veil') close(); };
  let media = null, mediaKind = null, moRec = null;
  $('#mo-img').onclick = () => $('#mo-file').click();
  $('#mo-file').onchange = async () => {
    const f = $('#mo-file').files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('Max 8 MB.', true);
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    media = await api('/upload', { body: { name: f.name, type: f.type, dataBase64: String(dataUrl).split(',')[1] } }).catch(e => (toast(esc(e.message), true), null));
    if (media) {
      mediaKind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'music' : 'image';
      $('#mo-img-name').textContent = `${mediaKind}: ${f.name.slice(0, 16)}`;
    }
  };
  // Voice moments: recorded right here, 24h like everything else
  $('#mo-voice').onclick = async () => {
    if (moRec?.state === 'recording') return moRec.stop();
    if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone not available.', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      moRec = new MediaRecorder(stream);
      moRec.ondataavailable = e => e.data.size && chunks.push(e.data);
      moRec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        $('#mo-voice-lbl').textContent = 'voice';
        const blob = new Blob(chunks, { type: moRec.mimeType || 'audio/webm' });
        if (blob.size < 1200) return;
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
        const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
        media = await api('/upload', { body: { name: `voice-moment.${ext}`, type: blob.type.split(';')[0], dataBase64: String(dataUrl).split(',')[1] } }).catch(e => (toast(esc(e.message), true), null));
        if (media) { mediaKind = 'voice'; $('#mo-voice-lbl').textContent = 'voice ✓'; }
      };
      moRec.start();
      $('#mo-voice-lbl').textContent = 'stop';
    } catch { toast('Microphone permission denied.', true); }
  };
  root.querySelectorAll('[data-mo-del]').forEach(b => b.onclick = async () => {
    await api('/stories/' + b.dataset.moDel, { method: 'DELETE' });
    close(); renderMoments();
  });
  $('#mo-post').onclick = async () => {
    const body = $('#mo-text').value.trim();
    if (!body && !media) return;
    await api('/stories', { body: { kind: media ? mediaKind : 'text', body, attachment: media, scope: $('#mo-scope').value } })
      .catch(e => toast(esc(e.message), true));
    toast(`${icon('sun', 14, 'accent')} Moment is live for 24 hours.`);
    close(); renderMoments();
  };
  $('#mo-text').focus();
}

function showMomentViewer(groups, userId) {
  const g = groups.find(x => x.user_id === userId);
  if (!g?.stories.length) return;
  let i = 0;
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; renderMoments(); };
  const draw = () => {
    const s = g.stories[i];
    api(`/stories/${s.id}/view`, { body: {} }).catch(() => {});
    root.innerHTML = `
    <div class="palette-veil" id="mv-veil"><div class="moment-view">
      <div class="mv-head">
        ${avatarHtml(g, 'sm')}<b>${esc(g.display_name)}</b>
        <span class="faint">${timeAgo(s.created_at)} ago${s.scope === 'inner' ? ' · inner circle' : ''}</span>
        <span class="faint" style="margin-left:auto">${i + 1}/${g.stories.length}</span>
        <button class="btn ghost small" id="mv-close">${icon('x', 12)}</button>
      </div>
      <div class="mv-dots">${g.stories.map((_, j) => `<span class="${j <= i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="mv-body">
        ${s.attachment && s.kind === 'video' ? `<video src="${esc(s.attachment.url)}" controls autoplay playsinline style="max-width:100%;max-height:52vh;border-radius:12px"></video>` : ''}
        ${s.attachment && ['voice', 'music'].includes(s.kind) ? `
          <div class="mv-audio">${icon(s.kind === 'voice' ? 'mic' : 'music', 34, 'accent')}
          <audio src="${esc(s.attachment.url)}" controls autoplay style="width:100%"></audio></div>` : ''}
        ${s.attachment && s.kind === 'image' ? `<img src="${esc(s.attachment.url)}" alt="">` : ''}
        ${s.body ? `<p>${richBody(s.body)}</p>` : ''}
      </div>
      <div class="mv-nav">
        <button id="mv-prev" ${i === 0 ? 'disabled' : ''}>${icon('chevLeft', 16)}</button>
        ${userId !== S.me.id ? `<input class="input" id="mv-reply" placeholder="reply to ${esc(g.display_name.split(' ')[0])}…"/>` : `<span class="faint">${s.views || 0} views</span>`}
        <button id="mv-next">${i < g.stories.length - 1 ? icon('chevDown', 16) : icon('check', 16)}</button>
      </div>
    </div></div>`;
    $('#mv-close').onclick = close;
    $('#mv-veil').onmousedown = e => { if (e.target.id === 'mv-veil') close(); };
    $('#mv-prev').onclick = () => { if (i > 0) { i--; draw(); } };
    $('#mv-next').onclick = () => { if (i < g.stories.length - 1) { i++; draw(); } else close(); };
    const reply = $('#mv-reply');
    if (reply) reply.onkeydown = e => {
      if (e.key === 'Enter' && reply.value.trim()) {
        const person = S.people.find(p => p.other_id === userId);
        if (person) {
          S.socket.emit('message:send', { conversationId: person.conversation_id, body: `(re: your moment "${(s.body || 'photo').slice(0, 40)}") ${reply.value.trim()}` }, r => {
            if (r?.ok) toast(`${icon('send', 13)} Sent.`);
          });
          reply.value = '';
        }
      }
    };
  };
  draw();
}

function drawPeopleBody(sorted, filter) {
  const q = filter.trim().toLowerCase();
  let list = q ? sorted.filter(p => p.display_name.toLowerCase().includes(q) || p.username.includes(q) || p.kind.toLowerCase().includes(q)) : sorted;
  const pill = S.peoplePill || 'all';
  if (pill === 'unread') list = list.filter(p => p.unread);
  if (pill === 'inner') list = list.filter(p => p.closeness === 1);
  if (pill === 'streak') list = list.filter(p => p.streak >= 2);
  const body = $('#people-body');
  if (!body) return;
  if (!list.length) { body.innerHTML = `<div class="empty"><span class="big">${icon('orbit', 34, 'dim')}</span>It's giving empty in here. ${pill === 'all' && !q ? 'Add your first human — a universe grows from one star.' : 'Nobody matches that filter.'}</div>`; return; }
  body.innerHTML = S.peopleView === 'map' ? constellationSvg(list)
    : S.peopleView === 'list' ? list.map(personRow).join('')
    : `<div class="people-bubbles">${list.map(personBubble).join('')}</div>`;
  body.querySelectorAll('[data-convo]').forEach(el => el.onclick = () => go('/chat/' + el.dataset.convo));
}

/* People as a bubble cloud — big pastel circles, not rows. People-first. */
function personBubble(p) {
  const ctx = p.context ? CTX_META[p.context] : null;
  return `
  <button class="p-bubble ${p.unread ? 'has-unread' : ''}" data-convo="${p.conversation_id}" title="${esc(p.display_name)}${ctx ? ' · ' + ctx[1] : ''}">
    <span class="p-bubble-av">
      ${avatarHtml(p, 'xl', true)}
      ${p.unread ? `<span class="unread-pill bub">${p.unread}</span>` : ''}
      ${p.vibe_streak >= 2 ? `<span class="bub-streak vibe" title="Vibe Check Streak — voice & video days only">${icon('mic', 10)}${p.vibe_streak}</span>`
        : p.streak >= 2 ? `<span class="bub-streak">${icon('flame', 10)}${p.streak}</span>` : ''}
      ${p.mood ? `<span class="bub-mood" title="feeling ${MOODS[p.mood]?.label || ''}">${mood(p.mood, 22)}</span>` : ''}
      ${p.rizz_king ? `<span class="bub-crown" title="Rizz King — won a battle, reigning 24h">${icon('crown', 13)}</span>` : ''}
    </span>
    <b>${esc(p.display_name.split(' ')[0])}</b>
    <span class="bub-sub">${ctx ? `${icon(ctx[0], 10)} ${ctx[1]}` : esc(p.kind)}</span>
  </button>`;
}

function personRow(p) {
  const ctx = p.context ? CTX_META[p.context] : null;
  const lm = p.last_message;
  return `
  <button class="person-row ${p.unread ? 'has-unread' : ''}" data-convo="${p.conversation_id}">
    ${avatarHtml(p, '', true)}
    <div class="info">
      <div class="top">
        <span class="nm">${esc(p.display_name)}</span>
        ${p.rizz_king ? `<span class="chip rizz-king" title="Rizz King — reigning 24h">${icon('crown', 11)}</span>` : ''}
        ${p.pinned ? icon('star4', 12, 'accent') : ''}
        ${p.muted ? icon('moon', 12, 'dim') : ''}
        <span class="chip">${esc(p.kind)}</span>
        ${p.streak >= 2 ? `<span class="chip streak">${icon('flame', 11)} ${p.streak}</span>` : ''}
        ${p.vibe_streak >= 2 ? `<span class="chip vibe-streak" title="Vibe Check Streak — voice & video days only">${icon('mic', 11)} ${p.vibe_streak}</span>` : ''}
        ${p.closeness === 1 ? '<span class="chip accent">inner circle</span>' : ''}
        ${ctx ? `<span class="chip">${icon(ctx[0], 12)} ${ctx[1]}${p.context_note ? ' · ' + esc(p.context_note) : ''}</span>` : ''}
      </div>
      <div class="last">${lm ? `${lm.mine ? 'You: ' : ''}${esc(lm.body)}` : '<i>Say the first word.</i>'}</div>
    </div>
    <div class="meta">
      ${lm ? `<span class="time">${timeAgo(lm.created_at)}</span>` : ''}
      ${p.unread ? `<span class="unread-pill ${lm?.priority === 'critical' ? 'critical' : ''}">${p.unread}</span>` : ''}
      ${lm && !p.unread && lm.priority !== 'normal' ? `<span class="chip ${lm.priority}" style="font-size:10px;padding:1px 7px">${lm.priority}</span>` : ''}
    </div>
  </button>`;
}

/* The Relationship Map — people as a constellation around you.
   Ring = closeness (inner circle orbits nearest), node size = shared history. */
function constellationSvg(people) {
  const W = 860, H = 460, cx = W / 2, cy = H / 2;
  const rings = { 1: 95, 2: 160, 3: 215 };
  const byRing = { 1: [], 2: [], 3: [] };
  people.forEach(p => byRing[p.closeness || 2].push(p));
  let nodes = '', links = '';
  for (const ring of [1, 2, 3]) {
    const group = byRing[ring];
    group.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / group.length - Math.PI / 2 + ring * 0.6;
      const x = cx + rings[ring] * Math.cos(angle) * (W / H) * 0.72;
      const y = cy + rings[ring] * Math.sin(angle);
      const r = Math.min(30, 13 + Math.sqrt(p.message_count || 0) * 2.4);
      const hue = p.avatar_hue ?? 210;
      links += `<line class="map-link" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" ${ring === 1 ? 'stroke-width="2" stroke="var(--accent-soft)"' : ''}/>`;
      nodes += `
      <g class="map-node" data-convo="${p.conversation_id}" transform="translate(${x},${y})">
        <circle r="${r + 4}" fill="hsl(${hue},62%,50%)" opacity=".18">${p.unread ? `<animate attributeName="opacity" values=".15;.45;.15" dur="1.6s" repeatCount="indefinite"/>` : ''}</circle>
        <circle r="${r}" fill="hsl(${hue},58%,46%)"/>
        <text dy="4">${esc(initials(p.display_name))}</text>
        <text class="sub" y="${r + 15}">${esc(p.display_name.split(' ')[0])} · ${esc(p.kind)}</text>
        ${p.unread ? `<circle r="6" cx="${r - 3}" cy="${-r + 3}" fill="var(--critical)"/>` : ''}
      </g>`;
    });
  }
  return `<div class="card map-wrap"><svg class="map-svg" viewBox="0 0 ${W} ${H}">
    ${links}
    <g class="map-node"><circle cx="${cx}" cy="${cy}" r="34" fill="var(--accent)"/><text x="${cx}" y="${cy + 5}" style="fill:var(--map-you,#fff);font-weight:800">You</text></g>
    ${nodes}
  </svg><div class="faint" style="text-align:center;padding-bottom:8px">Closer orbit = inner circle · bigger star = more shared history · pulsing = waiting for you</div></div>`;
}

function showAddPerson(prefill = '') {
  const body = $('#people-body');
  if ($('#add-card')) $('#add-card').remove();
  body.insertAdjacentHTML('afterbegin', `
  <div class="card" id="add-card" style="margin-bottom:14px">
    <div style="display:flex;gap:9px;flex-wrap:wrap">
      <input class="input" id="np-username" placeholder="@username or phone number" value="${esc(typeof prefill === 'string' ? prefill : '')}" style="max-width:220px" />
      <select class="input" id="np-kind" style="max-width:170px">${S.relKinds.map(k => `<option>${k}</option>`).join('')}</select>
      <select class="input" id="np-close" style="max-width:170px">
        <option value="2">Regular orbit</option><option value="1">Inner circle</option><option value="3">Outer orbit</option>
      </select>
      <button class="btn" id="np-add">Add to my universe</button>
    </div>
    <div class="faint" style="margin-top:8px">The relationship type teaches Ikvizz how much their words should weigh.</div>
  </div>`);
  $('#np-add').onclick = async () => {
    try {
      await api('/people', { body: { username: $('#np-username').value.replace(/^@/, ''), kind: $('#np-kind').value, closeness: Number($('#np-close').value) } });
      await refreshPeople(); renderPeople(); toast(`${icon('star4', 15, 'accent')} A new star in your universe.`);
    } catch (e) { toast(esc(e.message), true); }
  };
  $('#np-username').focus();
}

// ------------------------------------------------------------- chat view -----
async function openChat(conversationId) {
  const d = await api(`/conversations/${conversationId}/messages`).catch(() => null);
  if (!d) { go('/people'); return; }
  const convo = d.conversation;
  const other = convo.kind === 'dm' ? S.people.find(p => p.conversation_id === conversationId) : null;
  let spaceMeta = null;
  if (convo.kind === 'space') spaceMeta = await api('/spaces/' + convo.space_id).catch(() => null);
  let otherPub = null;
  if (other) otherPub = (await api('/people/' + other.other_id + '/profile').catch(() => null))?.public_key || null;

  // clear any capsule reveal timers from the previous chat
  for (const t of Object.values(S.capsuleTimers || {})) clearTimeout(t);
  S.capsuleTimers = {};
  if (typeof LIVE !== 'undefined' && LIVE.messageId) stopLiveLocation(); // don't keep sharing after leaving

  S.chat = {
    conversationId, messages: d.messages, other, convo, spaceMeta, otherPub,
    sealMode: false, intents: {}, replyTo: null, editing: null,
    othersReadTo: d.othersReadTo || 0, lastDayKey: null, unseenBelow: 0,
    pinned: d.pinned || [],
  };
  S.socket.emit('conversation:join', conversationId);
  S.socket.emit('conversation:read', conversationId);
  const p = S.people.find(x => x.conversation_id === conversationId);
  if (p) { p.unread = 0; updateBadges(); }

  main().innerHTML = `
  <div class="convo mglow">
    <div class="convo-main">
      <div class="convo-head" id="chat-head"></div>
      <div id="chat-tabs"></div>
      <div id="pin-strip"></div>
      <div id="reminder-bar"></div>
      <div class="mg-dust" aria-hidden="true"></div>
      <div class="msgs" id="msgs"></div>
      <button class="scroll-pill" id="scroll-pill" hidden>${icon('chevDown', 14)} <span id="pill-count"></span></button>
      <div class="intent-line" id="intent-line"></div>
      <div class="smart-replies" id="smart-replies"></div>
      <div class="react-bar" id="react-bar" hidden></div>
      <div class="emoji-panel" id="emoji-panel" hidden></div>
      <div id="composer-note"></div>
      <input type="file" id="file-input" hidden />
      <!-- the "+" tray: everything beyond the essentials lives here, one tap away -->
      <div class="plus-tray" id="plus-tray" hidden>
        <button class="tray-item" id="attach-btn"><span class="ti-ic ti-blue">${icon('image', 20)}</span><span>Photos & files</span></button>
        <button class="tray-item" id="camera-btn"><span class="ti-ic ti-pink">${icon('camera', 20)}</span><span>Camera</span></button>
        <button class="tray-item" id="loc-btn"><span class="ti-ic ti-green">${icon('mappin', 20)}</span><span>Location</span></button>
        <button class="tray-item" id="poll-btn"><span class="ti-ic ti-amber">${icon('checkCircle', 20)}</span><span>Poll</span></button>
        ${other ? `<button class="tray-item" id="songbomb-btn"><span class="ti-ic ti-violet">${icon('music', 20)}</span><span>Song bomb</span></button>` : ''}
        ${other ? `<button class="tray-item" id="seal-btn"><span class="ti-ic ti-slate">${icon('unlock', 20)}</span><span>Seal (E2E)</span></button>` : ''}
      </div>
      <div class="composer">
        <button class="btn ghost round" id="plus-btn" title="More — photos, camera, location, poll…" aria-label="More attachments">${icon('plus', 18)}</button>
        <button class="btn ghost round" id="emoji-btn" title="Emoji" aria-label="Emoji">${icon('smile', 17)}</button>
        <button class="btn ghost round" id="mood-btn" title="Tag how you mean it — the Emotion Layer" aria-label="Tag your mood">${icon('sparkle', 17)}</button>
        <textarea class="input" id="composer" rows="1" placeholder="${PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]}"></textarea>
        <button class="btn ghost round" id="mic-btn" title="Record a voice note" aria-label="Record a voice note">${icon('mic', 17)}</button>
        <button class="btn round" id="send-btn" title="Send" aria-label="Send message">${icon('send', 17)}</button>
      </div>
    </div>
    ${other ? `<aside class="side-panel" id="side-panel"></aside>` : ''}
  </div>`;

  renderChatHead();
  if (spaceMeta) {
    $('#chat-tabs').innerHTML = `<div class="tabs">${spaceTabs(spaceMeta.space).map(([k, ic, l]) => `<button class="tab ${k === 'chat' ? 'active' : ''}" data-tab="${k}">${icon(ic, 14)} ${l}</button>`).join('')}</div>`;
    $('#chat-tabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      if (b.dataset.tab !== 'chat') renderSpaceDetail(spaceMeta.space.id, b.dataset.tab);
    });
  }
  $('#msgs').innerHTML = '';
  const savedBg = localStorage.getItem('aether_bg_' + conversationId);
  if (savedBg) $('#msgs').dataset.bg = savedBg;
  d.messages.forEach(m => appendMessage(m, false));
  scrollMsgs();
  updateSeen();
  renderSmartReplies();
  wireComposer();
  wireScrollPill();
  renderPinStrip();
  startMidnightFx();
  updateVibeMeter();
  if (other) { renderSidePanel(); renderReminderBar(); }
}

/* ── Neon Midnight Arena ─────────────────────────────────────────────────────
   Midnight Effects: 12 AM–6 AM, gentle particles drift up the chat. The Vibe
   Meter (left edge) fills with how "lit" the last 40 messages are. Both are
   pure CSS-driven DOM, cheap, and self-clean when you leave the chat. */
function startMidnightFx() {
  clearInterval(S.midnightTimer);
  const layer = $('#midnight-fx');
  if (!layer) return;
  layer.innerHTML = '';
  const hour = new Date().getHours();
  if (hour >= 6) { layer.hidden = true; return; } // only the small hours
  layer.hidden = false;
  const glyphs = ['heart', 'star4', 'sparkle', 'moon'];
  const spawn = () => {
    if (S.view?.name !== 'chat' || !document.body.contains(layer)) return clearInterval(S.midnightTimer);
    const p = document.createElement('span');
    p.className = 'mfx';
    p.style.left = (Math.random() * 96) + '%';
    p.style.animationDuration = (7 + Math.random() * 6) + 's';
    p.style.opacity = String(0.15 + Math.random() * 0.35);
    p.innerHTML = icon(glyphs[Math.floor(Math.random() * glyphs.length)], 12 + Math.random() * 12);
    layer.appendChild(p);
    setTimeout(() => p.remove(), 13000);
  };
  for (let i = 0; i < 4; i++) setTimeout(spawn, i * 1500);
  S.midnightTimer = setInterval(spawn, 2600);
}

function updateVibeMeter() {
  const bar = $('#vibe-meter i');
  if (!bar || !S.chat) return;
  const ms = (S.chat.messages || []).filter(m => !m.deleted).slice(-40);
  if (!ms.length) { bar.style.height = '0%'; return; }
  const recent = ms.filter(m => Date.now() - m.created_at < 10 * 60_000).length; // last 10 min
  const energy = ms.filter(m => m.priority === 'critical' || m.priority === 'important'
    || (m.signals || []).some(s => ['idea', 'mood', 'effect'].includes(s.type))
    || /\b(lol|lmao|haha|omg|dead)\b/i.test(m.body || '')).length;
  const lit = Math.min(100, Math.round((recent * 9) + (energy / ms.length) * 60));
  bar.style.height = lit + '%';
  bar.dataset.lit = lit > 66 ? 'hot' : lit > 33 ? 'warm' : 'cool';
}

/* Pinned messages (Phase 6): the load-bearing lines float above the flow. */
async function renderPinStrip() {
  const strip = $('#pin-strip');
  if (!strip || !S.chat) return;
  if (!S.chat.pinned?.length) { strip.innerHTML = ''; return; }
  const convoId = S.chat.conversationId;
  const d = await api(`/conversations/${convoId}/pins`).catch(() => ({ pins: [] }));
  if (!S.chat || S.chat.conversationId !== convoId || !$('#pin-strip')) return;
  S.chat.pinned = d.pins.map(p => p.message_id);
  $('#pin-strip').innerHTML = d.pins.length ? `<div class="pin-strip">
    ${icon('pin', 13, 'accent')}
    <div class="pin-chips">${d.pins.map(p => `
      <button class="pin-chip" data-pin-jump="${p.message_id}" title="pinned by ${esc(p.pinned_by)}">
        <b>${esc(p.sender_name.split(' ')[0])}:</b> ${esc(p.body || 'attachment')}
      </button>`).join('')}</div>
  </div>` : '';
  $('#pin-strip').querySelectorAll('[data-pin-jump]').forEach(b => b.onclick = () => {
    const target = $(`#msgs [data-mid="${b.dataset.pinJump}"]`);
    if (!target) return toast('That message is further up the history.', false);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.querySelector('.bubble')?.classList.add('msg-flash');
    setTimeout(() => target.querySelector('.bubble')?.classList.remove('msg-flash'), 1300);
  });
}

/* Future Reminders: attached to the PERSON, not a clock — they surface here. */
async function renderReminderBar() {
  const other = S.chat?.other;
  const bar = $('#reminder-bar');
  if (!other || !bar) return;
  const d = await api(`/people/${other.other_id}/reminders`).catch(() => ({ reminders: [] }));
  if (!S.chat || S.chat.other?.other_id !== other.other_id) return;
  bar.innerHTML = d.reminders.map(r => `
    <div class="note-card remind-card">
      ${icon('bulb', 13, 'accent')}
      <div style="flex:1;white-space:normal">you wanted to bring up: <b>${esc(r.body)}</b></div>
      <button class="btn ghost small" data-rem-done="${r.id}">${icon('check', 12)} brought it up</button>
    </div>`).join('');
  bar.querySelectorAll('[data-rem-done]').forEach(b => b.onclick = async () => {
    await api('/reminders/' + b.dataset.remDone, { method: 'PATCH', body: {} });
    renderReminderBar();
  });
}

/* Scroll-to-bottom pill: appears when you scroll up; counts new arrivals. */
function wireScrollPill() {
  const box = $('#msgs'), pill = $('#scroll-pill');
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 260;
  box.onscroll = () => {
    if (nearBottom()) {
      pill.hidden = true;
      if (S.chat) { S.chat.unseenBelow = 0; S.socket.emit('conversation:read', S.chat.conversationId); }
    } else pill.hidden = false;
    $('#pill-count').textContent = S.chat?.unseenBelow ? `${S.chat.unseenBelow} new` : '';
  };
  pill.onclick = () => { scrollMsgs(); pill.hidden = true; if (S.chat) S.chat.unseenBelow = 0; };
}

const msgsNearBottom = () => {
  const box = $('#msgs');
  return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 260;
};

function renderChatHead() {
  const head = $('#chat-head');
  if (!head || !S.chat) return;
  const { other, spaceMeta } = S.chat;
  if (other) {
    const ctx = other.context ? CTX_META[other.context] : null;
    const [vibeLabel, vibeIc] = computeVibe();
    const dna = relationshipDna(other);
    head.innerHTML = `
      <button class="btn ghost small" id="back-btn">${icon('chevLeft', 16)}</button>
      ${avatarHtml(other, '', true)}
      <div class="who">
        <div class="nm">${esc(other.display_name)}
          ${other.mood ? `<span title="feeling ${MOODS[other.mood]?.label || ''}">${mood(other.mood, 20)}</span>` : ''}
          ${other.rizz_king ? `<span class="chip rizz-king" title="Rizz King — won a battle, reigning 24h">${icon('crown', 11)} rizz king</span>` : ''}
          <span class="chip">${esc(other.kind)}</span>
          ${other.streak >= 2 ? `<span class="chip streak" title="Chat streak — days you both showed up">${icon('flame', 11)} ${other.streak}</span>` : ''}
          ${other.vibe_streak >= 2 ? `<span class="chip vibe-streak" title="Vibe Check Streak — days you BOTH sent a voice note or video. Dry text doesn't count.">${icon('mic', 11)} ${other.vibe_streak}</span>` : ''}
          <span class="chip vibe" title="Vibe check — computed from the last 40 messages">${icon(vibeIc, 11)} ${vibeLabel}</span>
        </div>
        <div class="dna-line" title="Relationship DNA — grows with messages, streaks & memories">${icon('pulse', 12, 'accent')} Relationship DNA · Level ${dna.level}<span class="dna-track"><span style="width:${dna.pct}%"></span></span></div>
        <div class="st">${ctx ? `${icon(ctx[0], 12)} ${ctx[1]}${other.context_note ? ' — ' + esc(other.context_note) : ''}` : (other.online ? 'online' : 'context private')}</div>
      </div>
      <div class="head-acts">
        <button class="btn ghost small" id="call-a" title="Voice call" aria-label="Voice call">${icon('call', 15)}</button>
        <button class="btn ghost small" id="call-v" title="Video call" aria-label="Video call">${icon('video', 15)}</button>
        <button class="btn ghost small" id="ai-btn" aria-label="Catch me up">${icon('sparkle', 14, 'accent')} <span class="ai-lbl">Catch me up</span></button>
        <div class="head-more">
          <button class="btn ghost small" id="more-btn" title="More" aria-label="More actions">${icon('chevDown', 15)}</button>
          <div class="head-menu" id="head-menu" hidden>
            <button class="head-menu-row" id="rizz-btn">${icon('crown', 15, 'accent')} Rizz Battle</button>
            <button class="head-menu-row" id="music-btn">${icon('music', 15, 'accent')} Listen together</button>
            <button class="head-menu-row" id="bg-btn">${icon('image', 15, 'accent')} Chat background</button>
          </div>
        </div>
      </div>`;
  } else if (spaceMeta) {
    const liveCount = (S.roomCalls || {})[S.chat.conversationId] || 0;
    head.innerHTML = `
      <button class="btn ghost small" id="back-btn">${icon('chevLeft', 16)}</button>
      ${icon(spaceMeta.space.emoji, 26, 'accent')}
      <div class="who">
        <div class="nm">${esc(spaceMeta.space.name)}
          ${liveCount ? `<span class="chip streak" title="A call is live in this space">${icon('call', 11)} ${liveCount} in call</span>` : ''}
          ${spaceMeta.space.kind === 'moodsync' ? `<span class="chip important" title="MoodSync rooms dissolve into a memory capsule">${icon('timer', 11)} ${timeLeft(spaceMeta.space.expires_at)} left</span>` : ''}
        </div>
        <div class="st">${spaceMeta.members.map(m => esc(m.display_name.split(' ')[0])).join(', ')}</div>
      </div>
      <div class="head-acts">
        <button class="btn ghost small" id="gcall-a" title="${liveCount ? 'Join the voice room' : 'Start a voice room'}" aria-label="Voice room">${icon('call', 15)}${liveCount ? ' Join' : ''}</button>
        <button class="btn ghost small" id="gcall-v" title="Start a video room" aria-label="Video room">${icon('video', 15)}</button>
        <button class="btn ghost small" id="gcall-party" title="Party Vibez — group video with floating reactions">${icon('flame', 15)} Vibez</button>
        <button class="btn ghost small" id="ai-btn" aria-label="Catch me up">${icon('sparkle', 14, 'accent')} Catch me up</button>
      </div>`;
  }
  $('#back-btn').onclick = () => go(S.chat?.spaceMeta ? '/spaces' : '/people');
  const aiBtn = $('#ai-btn');
  if (aiBtn) aiBtn.onclick = showSummary;
  // Overflow menu (secondary DM actions)
  const moreBtn = $('#more-btn'), headMenu = $('#head-menu');
  if (moreBtn && headMenu) {
    moreBtn.onclick = e => { e.stopPropagation(); headMenu.hidden = !headMenu.hidden; };
    document.addEventListener('click', e => {
      if (!headMenu.hidden && !e.target.closest('#head-menu') && !e.target.closest('#more-btn')) headMenu.hidden = true;
    });
  }
  const closeMenu = () => { if (headMenu) headMenu.hidden = true; };
  const rz = $('#rizz-btn');
  if (rz && S.chat?.other) rz.onclick = () => { closeMenu(); showRizz(S.chat.other); };
  const mu = $('#music-btn');
  if (mu && S.chat?.other) mu.onclick = () => { closeMenu(); startMusicSync(); };
  const bg = $('#bg-btn');
  if (bg) bg.onclick = () => { closeMenu(); showBgPicker(); };
  const ca = $('#call-a'), cv = $('#call-v');
  if (ca && S.chat?.other) ca.onclick = () => startCall(S.chat.other, 'audio');
  if (cv && S.chat?.other) cv.onclick = () => startCall(S.chat.other, 'video');
  const ga = $('#gcall-a'), gv = $('#gcall-v'), gp = $('#gcall-party');
  if (ga && S.chat?.spaceMeta) ga.onclick = () => joinGroupCall(S.chat.conversationId, 'audio', S.chat.spaceMeta.space.name);
  if (gv && S.chat?.spaceMeta) gv.onclick = () => joinGroupCall(S.chat.conversationId, 'video', S.chat.spaceMeta.space.name);
  if (gp && S.chat?.spaceMeta) gp.onclick = () => joinGroupCall(S.chat.conversationId, 'video', S.chat.spaceMeta.space.name, true);
}

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

/* Custom voice/audio player — replaces the browser's default <audio controls>
   (which never matched the theme). One component, wired via wireAudio(). */
function audioHtml(url) {
  return `<div class="aud" data-aud>
    <button class="aud-play" aria-label="Play audio">${icon('play', 15)}</button>
    <div class="aud-body">
      <div class="aud-track" role="slider" aria-label="Seek"><div class="aud-fill"></div></div>
      <div class="aud-meta"><span class="aud-time">0:00</span><button class="aud-rate" title="Playback speed">1×</button></div>
    </div>
    <audio preload="metadata" src="${esc(url)}"></audio>
  </div>`;
}
const _audFmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function wireAudio(root) {
  (root || document).querySelectorAll('.aud[data-aud]:not([data-wired])').forEach(el => {
    el.dataset.wired = '1';
    const audio = el.querySelector('audio'), play = el.querySelector('.aud-play');
    const fill = el.querySelector('.aud-fill'), timeEl = el.querySelector('.aud-time');
    const rate = el.querySelector('.aud-rate'), track = el.querySelector('.aud-track');
    const setIcon = p => play.innerHTML = icon(p ? 'pause' : 'play', 15);
    play.onclick = () => {
      if (audio.paused) { document.querySelectorAll('.aud audio').forEach(a => a !== audio && a.pause()); audio.play().catch(() => {}); }
      else audio.pause();
    };
    audio.onplay = () => { setIcon(true); el.classList.add('playing'); };
    audio.onpause = () => { setIcon(false); el.classList.remove('playing'); };
    audio.onended = () => { setIcon(false); el.classList.remove('playing'); fill.style.width = '0%'; timeEl.textContent = _audFmt(audio.duration); };
    audio.onloadedmetadata = () => { if (isFinite(audio.duration)) timeEl.textContent = _audFmt(audio.duration); };
    audio.ontimeupdate = () => {
      const d = audio.duration || 0;
      fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      timeEl.textContent = _audFmt(audio.paused && !audio.currentTime ? d : audio.currentTime);
    };
    track.onclick = e => { const r = track.getBoundingClientRect(); if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; };
    const rates = [1, 1.5, 2]; let ri = 0;
    rate.onclick = () => { ri = (ri + 1) % rates.length; audio.playbackRate = rates[ri]; rate.textContent = rates[ri] + '×'; };
  });
}

function attachmentHtml(att) {
  if (!att) return '';
  if ((att.type || '').startsWith('image/')) {
    return `<a href="${esc(att.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(att.url)}" alt="${esc(att.name)}" loading="lazy"></a>`;
  }
  if ((att.type || '').startsWith('audio/')) {
    return audioHtml(att.url);
  }
  return `<a class="att-file" href="${esc(att.url)}" target="_blank" rel="noopener" download="${esc(att.name)}">${icon('paperclip', 14)} ${esc(att.name)} <span class="faint">${fmtSize(att.size || 0)}</span></a>`;
}

/** View-once photo bubble — a placeholder; the image lives one tap away. */
function viewOnceHtml(m, mine) {
  const sig = (m.signals || []).find(s => s.type === 'viewonce');
  if (!sig) return '';
  if (sig.opened) {
    return `<div class="vo-card opened">${icon('eyeOff', 15)}<span>Photo · opened</span></div>`;
  }
  if (mine) {
    return `<div class="vo-card sent">${icon('eye', 15)}<span>Photo · view once</span></div>`;
  }
  return `<button class="vo-card ready" data-vo="${m.id}">${icon('eye', 15)}<span>Tap to view</span><em>view once</em></button>`;
}

/** Flip a view-once message to its spent state and re-render its bubble. */
function markViewOnceOpened(messageId) {
  const m = (S.chat?.messages || []).find(x => x.id === messageId);
  if (!m) return;
  const sig = (m.signals || []).find(s => s.type === 'viewonce');
  if (sig && !sig.opened) { sig.opened = true; m.attachment = null; refreshMessageNode(m); }
}

/**
 * Full-screen view-once viewer: the image is held only in this transient node,
 * with no download/context-menu affordance, and dropped the moment it closes.
 * A short auto-close backs up a manual tap so it can't linger on screen.
 */
function showViewOnceViewer(url) {
  const root = $('#palette-root');
  let left = 12;
  const wrap = document.createElement('div');
  wrap.className = 'vo-viewer';
  wrap.innerHTML = `
    <div class="vo-top"><span class="vo-count">${left}s</span><button class="vo-close" aria-label="Close">${icon('x', 18)}</button></div>
    <img class="vo-img" alt="View-once photo" oncontextmenu="return false" draggable="false">
    <div class="vo-hint">${icon('eyeOff', 13)} This photo disappears when you close it</div>`;
  root.appendChild(wrap);
  const img = wrap.querySelector('.vo-img');
  img.src = url;
  const done = () => {
    clearInterval(tick);
    img.removeAttribute('src'); // drop the pixels; the URL is already spent server-side
    wrap.remove();
  };
  const tick = setInterval(() => {
    left -= 1;
    wrap.querySelector('.vo-count').textContent = `${left}s`;
    if (left <= 0) done();
  }, 1000);
  wrap.querySelector('.vo-close').onclick = done;
  wrap.addEventListener('click', e => { if (e.target === wrap) done(); });
}

/** Escaped body with live links and highlighted @mentions. */
const richBody = text => esc(text)
  .replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
  .replace(/(^|\s)@([a-z0-9_]+)/gi, (_, pre, name) => `${pre}<span class="mention">@${name}</span>`);

/** Poll bubbles: options, live bars, one vote per person (changeable). */
function pollHtml(m) {
  const options = (m.signals || []).find(s => s.type === 'poll')?.options || [];
  const v = m.votes || { counts: {}, total: 0, mine: null };
  return `<div class="poll" data-pmid="${m.id}">
    ${options.map((o, i) => {
      const n = v.counts[i] || 0;
      const pct = v.total ? Math.round((n / v.total) * 100) : 0;
      return `<button class="poll-opt ${v.mine === i ? 'mine' : ''}" data-poll-opt="${i}">
        <span class="poll-bar" style="width:${pct}%"></span>
        <span class="poll-label">${esc(o)}</span><span class="poll-n">${n}</span>
      </button>`;
    }).join('')}
    <div class="faint" style="margin-top:4px">${v.total} vote${v.total === 1 ? '' : 's'} · tap to vote</div>
  </div>`;
}

// Reactions are Ikvizz moods now (legacy icon kinds still render fine)
const REACT_SET = MOOD_KINDS;

function reactionsHtml(m) {
  const rs = m.reactions || [];
  if (!rs.length) return '';
  return `<div class="react-row">${rs.map(r =>
    `<button class="react-chip ${r.mine ? 'mine' : ''}" data-react="${r.kind}" data-rmid="${m.id}">${mood(r.kind, 15)} ${r.count}</button>`).join('')}</div>`;
}

/* Midnight Glow reaction bar — opens just above the input, horizontal scroll of
   our custom emoji. Pick one → it lands on the message's top-left corner. */
function openReactBar(messageId) {
  const bar = $('#react-bar');
  if (!bar) return;
  S.reactTarget = messageId;
  bar.innerHTML = REACT_SET.map(k => `<button data-rb="${k}" title="${MOODS[k]?.label || k}">${mood(k, 26)}</button>`).join('');
  bar.hidden = false;
  bar.querySelectorAll('[data-rb]').forEach(b => b.onclick = () => {
    S.socket.emit('reaction:toggle', { messageId: S.reactTarget, kind: b.dataset.rb });
    closeReactBar();
  });
  // Nudge the target message so you can see it land
  const node = $(`#msgs [data-mid="${messageId}"] .bubble`);
  node?.classList.add('react-target');
}
function closeReactBar() {
  const bar = $('#react-bar');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
  document.querySelectorAll('.bubble.react-target').forEach(b => b.classList.remove('react-target'));
  S.reactTarget = null;
}

// A small, expressive emoji set for typing (standard unicode goes in text).
const TYPE_EMOJI = ['😭','😂','💀','🔥','❤️','🥹','✨','😩','🙏','😳','👀','😤','🫶','😮‍💨','🤝','💯','🥲','😎','🫠','🤌','😅','🥶','🙌','😔'];
function toggleEmojiPanel() {
  const panel = $('#emoji-panel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.innerHTML = TYPE_EMOJI.map(e => `<button data-emo="${e}">${e}</button>`).join('');
  panel.hidden = false;
  panel.querySelectorAll('[data-emo]').forEach(b => b.onclick = () => {
    const ta = $('#composer');
    if (ta) { ta.value += b.dataset.emo; ta.dispatchEvent(new Event('input')); ta.focus(); }
  });
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function messageHtml(m, prev) {
  const mine = m.sender.id === S.me.id;
  const gap = !prev || prev.sender.id !== m.sender.id || m.created_at - prev.created_at > 5 * 60_000;
  const showFrom = !mine && gap && S.chat.convo.kind === 'space';
  const sealed = m.kind === 'sealed';

  if (m.deleted) {
    return `
    <div class="msg ${mine ? 'mine' : ''} ${gap ? 'gap' : ''}" data-mid="${m.id}">
      ${!mine && gap ? avatarHtml(m.sender, 'sm') : (!mine ? '<span style="width:30px;flex-shrink:0"></span>' : '')}
      <div class="bubble"><span class="deleted-msg">${icon('trash', 12)} This message ran away</span></div>
    </div>`;
  }

  // Time Capsule: dark until its moment arrives — for everyone, sender included
  const capsuleSig = (m.signals || []).find(s => s.type === 'capsule');
  const lockedCapsule = capsuleSig && capsuleSig.at > Date.now();
  if (lockedCapsule) {
    const when = new Date(capsuleSig.at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    return `
    <div class="msg ${mine ? 'mine' : ''} ${gap ? 'gap' : ''}" data-mid="${m.id}">
      ${!mine && gap ? avatarHtml(m.sender, 'sm') : (!mine ? '<span style="width:30px;flex-shrink:0"></span>' : '')}
      <div class="bubble capsule-bubble">
        <div class="cap-lock">${icon('clock', 16)}</div>
        <div><b>Time capsule</b><div class="faint">sealed until ${when} — not even the sender can peek</div></div>
      </div>
    </div>`;
  }

  const moodSig = (m.signals || []).find(s => s.type === 'mood');
  const isSilent = (m.signals || []).some(s => s.type === 'silent');
  const sigs = sealed ? `<span class="sig sealed">${icon('lock', 11)} end-to-end</span>` : (m.signals || []).map(s => {
    if (s.type === 'silent') return `<span class="sig silent">${icon('moon', 11)} silent thought</span>`;
    if (s.type === 'capsule') return `<span class="sig capsule">${icon('clock', 11)} capsule · opened</span>`;
    if (s.type === 'fwd') return `<span class="sig">${icon('forward', 11)} forwarded</span>`;
    const meta = SIG_META[s.type];
    return meta ? `<span class="sig ${s.type}">${icon(meta[0], 11)} ${meta[1]}${s.due ? ' · ' + esc(s.due) : ''}</span>` : '';
  }).join('');
  const moodBadge = moodSig ? `<span class="mood-badge" title="tagged: ${MOODS[moodSig.kind]?.label || moodSig.kind}">${mood(moodSig.kind, 26)}</span>` : '';
  const bodyHtml = sealed ? `<span class="sealed-body" data-sealed>decrypting…</span>` : richBody(m.body);
  const quote = m.reply ? `
    <button class="reply-quote" data-jump="${m.reply.id}">
      <b>${esc(m.reply.name)}</b><span>${esc(m.reply.body)}</span>
    </button>` : '';

  const acts = [
    `<button data-open-react title="React">${icon('smile', 13)}</button>`,
    `<button data-reply="${m.id}" title="Reply">${icon('reply', 13)}</button>`,
    sealed ? '' : `<button data-fwd="${m.id}" title="Forward">${icon('forward', 13)}</button>`,
    sealed || !m.body ? '' : `<button data-copy="${m.id}" title="Copy text">${icon('copy', 13)}</button>`,
    sealed ? '' : `<button data-remember="${m.id}" title="Remember this forever">${icon('star', 13)}</button>`,
    `<button data-pin="${m.id}" title="${S.chat?.pinned?.includes(m.id) ? 'Unpin' : 'Pin to the top'}" ${S.chat?.pinned?.includes(m.id) ? 'class="pin-on"' : ''}>${icon('pin', 13)}</button>`,
    mine && !sealed && !m.attachment ? `<button data-edit="${m.id}" title="Edit">${icon('pen', 13)}</button>` : '',
    mine ? `<button data-del="${m.id}" title="Remove">${icon('trash', 13)}</button>` : '',
  ].join('');

  return `
  <div class="msg ${mine ? 'mine' : ''} ${gap ? 'gap' : ''}" data-mid="${m.id}">
    ${!mine && gap ? avatarHtml(m.sender, 'sm') : (!mine ? '<span style="width:30px;flex-shrink:0"></span>' : '')}
    <div class="bubble-wrap">
      <div class="bubble prio-edge ${m.priority} ${isSilent ? 'silent-bubble' : ''}">
        ${moodBadge}
        ${showFrom ? `<div class="frm">${esc(m.sender.display_name)}</div>` : ''}
        ${quote}
        ${(m.signals || []).some(s => s.type === 'viewonce') ? viewOnceHtml(m, mine) : attachmentHtml(m.attachment)}
        ${(m.signals || []).find(s => s.type === 'location') ? locationHtml((m.signals).find(s => s.type === 'location')) : ''}
        ${bodyHtml ? `<div class="body-text">${bodyHtml}</div>` : ''}
        ${m.kind === 'poll' ? pollHtml(m) : ''}
        <div class="meta-line"><span class="tm">${clock(m.created_at)}${m.edited_at ? ' · edited' : ''}</span>${sigs}${!sealed && m.priority !== 'normal' ? `<span class="sig" style="color:var(--${m.priority});background:var(--${m.priority}-soft)">${m.priority}</span>` : ''}</div>
      </div>
      ${reactionsHtml(m)}
    </div>
    <div class="hover-acts">${acts}</div>
  </div>`;
}

/** Wire up all interactive parts of a rendered message node. */
function wireMessageNode(node, m) {
  if (m.kind === 'sealed') decryptInto(node, m);
  const img = node.querySelector('.att-img');
  if (img) img.onload = () => { if (msgsNearBottom()) scrollMsgs(); };
  wireAudio(node); // custom voice-note player

  // Time capsule: schedule an auto-reveal the moment it unlocks (no reload needed)
  const cap = (m.signals || []).find(s => s.type === 'capsule');
  if (cap && cap.at > Date.now()) {
    const delay = Math.min(cap.at - Date.now() + 800, 2 ** 31 - 1);
    S.capsuleTimers ||= {};
    clearTimeout(S.capsuleTimers[m.id]);
    S.capsuleTimers[m.id] = setTimeout(() => revealCapsule(m.id), delay);
  }

  node.querySelector('[data-remember]')?.addEventListener('click', async () => {
    try {
      await api('/memories', { body: { messageId: m.id } });
      toast(`${icon('star', 15, 'accent')} Saved forever. No takebacks.`);
      if (S.chat?.other) renderSidePanel();
    } catch (e) { toast(esc(e.message), true); }
  });

  node.querySelector('[data-reply]')?.addEventListener('click', () => {
    if (!S.chat) return;
    S.chat.editing = null;
    S.chat.replyTo = { id: m.id, name: m.sender.display_name, body: m.kind === 'sealed' ? 'Encrypted message' : (m.body || m.attachment?.name || '').slice(0, 120) };
    renderComposerNote();
    $('#composer')?.focus();
  });

  node.querySelector('[data-edit]')?.addEventListener('click', () => {
    if (!S.chat) return;
    S.chat.replyTo = null;
    S.chat.editing = m.id;
    const ta = $('#composer');
    if (ta) { ta.value = m.body; ta.dispatchEvent(new Event('input')); ta.focus(); }
    renderComposerNote();
  });

  node.querySelector('[data-del]')?.addEventListener('click', () => {
    S.socket.emit('message:delete', { messageId: m.id }, r => { if (!r?.ok) toast(esc(r?.error || 'Could not remove'), true); });
  });

  node.querySelector('[data-fwd]')?.addEventListener('click', () => showForward(m));

  node.querySelector('[data-pin]')?.addEventListener('click', async () => {
    try {
      const r = await api(`/messages/${m.id}/pin`, { body: {} });
      if (!S.chat) return;
      S.chat.pinned = r.pinned ? [...(S.chat.pinned || []), m.id] : (S.chat.pinned || []).filter(id => id !== m.id);
      refreshMessageNode(m);
      renderPinStrip();
      toast(r.pinned ? `${icon('pin', 14, 'accent')} Pinned.` : `${icon('pin', 14)} Unpinned.`);
    } catch (e) { toast(esc(e.message), true); }
  });

  node.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(m.body || ''); toast(`${icon('copy', 13)} Copied.`); } catch { }
  });

  // Voice notes: cycle playback speed 1× → 1.5× → 2×
  const audio = node.querySelector('.att-audio');
  if (audio) {
    const btn = document.createElement('button');
    btn.className = 'audio-speed';
    btn.textContent = '1×';
    audio.insertAdjacentElement('afterend', btn);
    btn.onclick = () => {
      audio.playbackRate = audio.playbackRate >= 2 ? 1 : audio.playbackRate + 0.5;
      btn.textContent = audio.playbackRate + '×';
    };
  }

  // Poll voting
  node.querySelectorAll('[data-poll-opt]').forEach(b => b.onclick = () => {
    S.socket.emit('poll:vote', { messageId: m.id, opt: Number(b.dataset.pollOpt) }, r => {
      if (r?.ok) { m.votes = r.votes; refreshMessageNode(m); }
      else toast(esc(r?.error || 'Could not vote'), true);
    });
  });

  // View-once photo: opening consumes it server-side, then shows it exactly once.
  node.querySelector('[data-vo]')?.addEventListener('click', e => {
    e.stopPropagation();
    S.socket.emit('message:viewonce:open', { messageId: m.id }, r => {
      if (!r?.ok) { toast(esc(r?.error || 'This photo is no longer available.'), true); markViewOnceOpened(m.id); return; }
      showViewOnceViewer(r.url); // the ONLY time this URL is ever handed to the client
      // The server broadcast flips the bubble; do it locally too for instant feedback.
      markViewOnceOpened(m.id);
    });
  });

  // Midnight Glow reactions: the hover ⊕ and long-press both open the reaction
  // bar that sits JUST ABOVE THE INPUT (not floating at the message).
  node.querySelector('[data-open-react]')?.addEventListener('click', e => {
    e.stopPropagation();
    openReactBar(m.id);
  });
  const bub = node.querySelector('.bubble');
  if (bub) {
    let pressT = null, moved = false, longFired = false;
    const start = () => { moved = false; longFired = false; pressT = setTimeout(() => { if (!moved) { longFired = true; openReactBar(m.id); if (navigator.vibrate) navigator.vibrate(12); } }, 380); };
    const cancel = () => clearTimeout(pressT);
    bub.addEventListener('touchstart', start, { passive: true });
    bub.addEventListener('touchmove', () => { moved = true; cancel(); }, { passive: true });
    bub.addEventListener('touchend', cancel);
    bub.addEventListener('mousedown', start); bub.addEventListener('mouseup', cancel); bub.addEventListener('mouseleave', cancel);
    // A short tap (not a long-press, not a link/media click) toggles the action
    // bar — this is the ONLY way reply/edit/delete/forward reach touch users.
    bub.addEventListener('click', e => {
      if (longFired) { longFired = false; return; }
      if (e.target.closest('a, button, audio, video, .att-img, [data-jump], [data-poll-opt]')) return;
      const wasOpen = node.classList.contains('acts-open');
      document.querySelectorAll('.msg.acts-open').forEach(n => n.classList.remove('acts-open'));
      if (!wasOpen) node.classList.add('acts-open');
    });
  }
  node.querySelectorAll('[data-react]').forEach(b => b.onclick = () => {
    S.socket.emit('reaction:toggle', { messageId: m.id, kind: b.dataset.react });
  });

  node.querySelector('[data-jump]')?.addEventListener('click', () => {
    const target = $(`#msgs [data-mid="${m.reply.id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.querySelector('.bubble')?.classList.add('msg-flash');
      setTimeout(() => target.querySelector('.bubble')?.classList.remove('msg-flash'), 1300);
    }
  });
}

/** Re-render one message in place (edits, deletes, reactions). */
function refreshMessageNode(m) {
  const node = $(`#msgs [data-mid="${m.id}"]`);
  if (!node) return;
  const idx = S.chat.messages.findIndex(x => x.id === m.id);
  const prev = idx > 0 ? S.chat.messages[idx - 1] : null;
  node.outerHTML = messageHtml(m, prev);
  const fresh = $(`#msgs [data-mid="${m.id}"]`);
  if (fresh) wireMessageNode(fresh, m);
}

/** A time capsule just hit its unlock moment — pull the now-open copy and swap it in. */
async function revealCapsule(mid) {
  if (!S.chat) return;
  const d = await api(`/conversations/${S.chat.conversationId}/messages`).catch(() => null);
  if (!d || !S.chat) return;
  const fresh = d.messages.find(x => x.id === mid);
  const idx = S.chat.messages.findIndex(x => x.id === mid);
  if (fresh && idx >= 0) { S.chat.messages[idx] = fresh; refreshMessageNode(fresh); toast(`${icon('clock', 14, 'accent')} A time capsule just opened.`); }
}

/** "Seen" under your last message the other side has read. */
function updateSeen() {
  if (!S.chat || S.chat.convo.kind !== 'dm') return;
  $('#msgs .seen-line')?.remove();
  const lastSeenOwn = [...S.chat.messages].reverse()
    .find(m => m.sender.id === S.me.id && !m.deleted && m.id <= S.chat.othersReadTo);
  if (!lastSeenOwn) return;
  const node = $(`#msgs [data-mid="${lastSeenOwn.id}"]`);
  node?.insertAdjacentHTML('afterend', `<div class="seen-line">${icon('check', 10)} Seen</div>`);
}

/* Smart replies — honest rule-based suggestions from the brain's signals. */
function computeSmartReplies() {
  if (!S.chat) return [];
  const last = [...S.chat.messages].reverse().find(m => !m.deleted && m.sender.id !== S.me.id && m.kind !== 'sealed' && m.body);
  if (!last || S.chat.messages[S.chat.messages.length - 1]?.sender.id === S.me.id) return [];
  const has = t => (last.signals || []).some(s => s.type === t);
  if (last.priority === 'critical') return ['On it right now', 'Give me 10 minutes', 'Calling you'];
  if (has('question')) return ['Yes', 'No', 'Let me consult my vibes and get back to you'];
  if (has('promise')) return ['Noted — holding you to it', 'Screenshot taken, no escape'];
  if (has('idea')) return ['Okay genius, log it in the space', 'Love this idea'];
  if (/thank/i.test(last.body)) return ['Anytime', 'You owe me one'];
  return [];
}

function renderSmartReplies() {
  const row = $('#smart-replies');
  if (!row) return;
  const replies = computeSmartReplies();
  row.innerHTML = replies.map(r => `<button data-sr="${esc(r)}">${esc(r)}</button>`).join('');
  row.querySelectorAll('[data-sr]').forEach(b => b.onclick = () => {
    const ta = $('#composer');
    if (ta) { ta.value = b.dataset.sr; ta.dispatchEvent(new Event('input')); ta.focus(); }
  });
}

/* Reply / edit banner above the composer. */
function renderComposerNote() {
  const box = $('#composer-note');
  if (!box || !S.chat) return;
  if (S.chat.replyTo) {
    box.innerHTML = `<div class="note-card">${icon('reply', 13, 'accent')}<div style="flex:1;min-width:0">Replying to <b>${esc(S.chat.replyTo.name)}</b> — <span class="muted">${esc(S.chat.replyTo.body)}</span></div><button class="btn ghost small" id="note-cancel">${icon('x', 11)}</button></div>`;
  } else if (S.chat.editing) {
    box.innerHTML = `<div class="note-card">${icon('pen', 13, 'accent')}<div style="flex:1">Editing message</div><button class="btn ghost small" id="note-cancel">${icon('x', 11)}</button></div>`;
  } else { box.innerHTML = ''; return; }
  $('#note-cancel').onclick = () => {
    if (S.chat.editing) { const ta = $('#composer'); if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); } }
    S.chat.replyTo = null; S.chat.editing = null;
    renderComposerNote();
  };
}

/** Decrypt a sealed message in place — the DM shared key works both directions. */
async function decryptInto(node, m) {
  const span = node.querySelector('[data-sealed]');
  if (!span) return;
  try {
    if (!S.chat?.otherPub || !S.privKey) throw new Error('no key');
    const key = await dmKey(S.chat.other.other_id, S.chat.otherPub);
    span.textContent = await unsealText(m.body, key);
  } catch {
    span.textContent = 'Encrypted — key not available on this device';
    span.classList.add('faint');
  }
}

function appendMessage(m, scroll = true) {
  const box = $('#msgs');
  if (!box) return;
  // Day divider when the calendar page turns
  const dayKey = new Date(m.created_at).toDateString();
  if (dayKey !== S.chat.lastDayKey) {
    S.chat.lastDayKey = dayKey;
    box.insertAdjacentHTML('beforeend', `<div class="day-divider"><span>${dayLabel(m.created_at)}</span></div>`);
  }
  const prev = S.chat.messages[S.chat.messages.indexOf(m) - 1] || S.chat.messages[S.chat.messages.length - 2];
  box.insertAdjacentHTML('beforeend', messageHtml(m, prev));
  wireMessageNode(box.lastElementChild, m);
  if (scroll) scrollMsgs();
}

// Close any open popovers when clicking elsewhere
document.addEventListener('click', e => {
  document.querySelectorAll('.react-pop').forEach(p => { p.hidden = true; });
  $('#mood-pop')?.remove();
  // Close the reaction bar / emoji panel when clicking outside them
  if (!e.target.closest('#react-bar') && !e.target.closest('[data-open-react]') && !e.target.closest('.bubble')) closeReactBar();
  if (!e.target.closest('#emoji-panel') && !e.target.closest('#emoji-btn')) { const p = $('#emoji-panel'); if (p) p.hidden = true; }
  // Close any open message action bar when tapping elsewhere
  if (!e.target.closest('.msg')) document.querySelectorAll('.msg.acts-open').forEach(n => n.classList.remove('acts-open'));
});

/* ---- message effects: little moments of joy -------------------------------- */
/* Night Decay: the newest incoming message slowly blurs away unless you
   actually reply. Dry-text era is over — silence has consequences. */
function updateDecay() {
  if (!S.chat || S.chat.convo?.kind !== 'dm' || !$('#msgs')) return;
  const msgs = S.chat.messages.filter(m => !m.deleted);
  const last = msgs[msgs.length - 1];
  document.querySelectorAll('#msgs .decaying').forEach(el => {
    el.classList.remove('decaying'); el.style.removeProperty('--decay'); el.style.opacity = '';
  });
  document.querySelectorAll('#msgs .decay-pill').forEach(p => p.remove());
  if (!last || last.sender.id === S.me.id) return; // you replied — it revives
  if (S.chat.revived?.has(last.id)) return;         // you chose to keep it
  const age = Date.now() - last.created_at;
  if (age < 90_000) return;                        // 90s of grace
  const t = Math.min(1, (age - 90_000) / 300_000); // eases to its faded rest state
  const bubble = $(`#msgs [data-mid="${last.id}"] .bubble`);
  if (bubble) {
    // Gentle, legible fade — a clear "this is drifting away" cue, not a glitch.
    // Blur is capped low so the text stays readable; a pill makes it actionable.
    bubble.classList.add('decaying');
    bubble.style.setProperty('--decay', t.toFixed(2));
    bubble.style.opacity = (1 - t * 0.34).toFixed(2); // floor ~0.66
    // The pill lives on the (unblurred) wrapper so it stays crisp + tappable.
    const wrap = bubble.closest('.bubble-wrap') || bubble;
    if (!wrap.querySelector('.decay-pill')) {
      const pill = document.createElement('button');
      pill.className = 'decay-pill';
      pill.innerHTML = `${icon('sparkle', 11)} fading — tap to keep`;
      pill.onclick = e => {
        e.stopPropagation();
        (S.chat.revived ||= new Set()).add(last.id);
        bubble.classList.remove('decaying'); bubble.style.opacity = ''; bubble.style.removeProperty('--decay');
        pill.remove();
      };
      wrap.appendChild(pill);
    }
  }
}
setInterval(updateDecay, 8000);

function runEffect(kind) {
  if (kind === 'flip') { // Flip the Chat: 60 seconds of upside-down meme chaos
    const box = $('#msgs');
    if (!box || box.classList.contains('flipped')) return;
    box.classList.add('flipped');
    toast(`${icon('zap', 15, 'accent')} chat flipped — 60 seconds of chaos`);
    setTimeout(() => $('#msgs')?.classList.remove('flipped'), 60_000);
    return;
  }
  if (kind === 'shake') {
    const box = $('#msgs');
    if (box) { box.classList.add('do-shake'); setTimeout(() => box.classList.remove('do-shake'), 650); }
    return;
  }
  if (kind !== 'confetti') return;
  const root = document.createElement('div');
  root.className = 'confetti-root';
  const hues = [230, 260, 174, 45, 350, 200];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    const h = hues[i % hues.length];
    p.style.cssText = `left:${Math.random() * 100}%;background:hsl(${h},80%,${55 + Math.random() * 15}%);` +
      `animation-duration:${1.4 + Math.random() * 1.3}s;animation-delay:${Math.random() * .4}s;` +
      `width:${5 + Math.random() * 6}px;height:${8 + Math.random() * 8}px;--spin:${Math.random() > .5 ? 1 : -1};`;
    root.appendChild(p);
  }
  document.body.appendChild(root);
  setTimeout(() => root.remove(), 3200);
}

/* ---- Vibe Check: what kind of chat is this, really? ------------------------ */
// Relationship DNA — a friendly "level" grown from real signals already tracked:
// how much you talk, your streaks, and the memories you've saved together.
function relationshipDna(other) {
  const msgs = other.message_count || 0;
  const streak = other.streak || 0;
  const vibe = other.vibe_streak || 0;
  const score = msgs + streak * 8 + vibe * 12;
  // levels at 0,25,60,110,180,270,380,520,700,1000 — early levels feel reachable
  const rungs = [0, 25, 60, 110, 180, 270, 380, 520, 700, 1000];
  let level = 1;
  for (let i = 0; i < rungs.length; i++) if (score >= rungs[i]) level = i + 1;
  const lo = rungs[level - 1] ?? 0, hi = rungs[level] ?? (lo + 400);
  const pct = Math.max(6, Math.min(100, Math.round(((score - lo) / (hi - lo)) * 100)));
  return { level: Math.min(level, 10), pct };
}

function computeVibe() {
  const ms = (S.chat?.messages || []).filter(m => !m.deleted && m.body && m.kind !== 'sealed').slice(-40);
  if (ms.length < 4) return ['fresh chat energy', 'sparkle'];
  const n = ms.length;
  const count = f => ms.filter(f).length;
  const has = (m, t) => (m.signals || []).some(s => s.type === t);
  const laughs = count(m => /\b(lol|lmao|haha|hehe|dead|crying)\b|😂|💀|🤣/i.test(m.body));
  const urgent = count(m => m.priority === 'critical' || m.priority === 'important');
  const ideas = count(m => has(m, 'idea'));
  const questions = count(m => has(m, 'question'));
  const promises = count(m => has(m, 'promise'));
  const myShare = count(m => m.sender.id === S.me.id) / n;
  if (laughs / n > 0.18) return ['comedy club', 'smile'];
  if (urgent / n > 0.3) return ['high stakes era', 'alert'];
  if (ideas >= 3) return ['chaotic genius energy', 'bulb'];
  if (promises >= 2) return ['accountability duo', 'flag'];
  if (questions / n > 0.4) return ['interview vibes', 'help'];
  if (myShare > 0.75) return ['carrying this convo', 'dumbbell'];
  if (myShare < 0.25) return ['getting yapped at', 'message'];
  return ['certified yappers', 'zap'];
}

/* ---- Friendship Wrapped: the receipts, lovingly presented ------------------- */
async function showWrapped() {
  if (!S.chat?.other) return;
  const w = await api(`/people/${S.chat.other.other_id}/wrapped`).catch(() => null);
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  if (!w || w.tooEarly) { toast('Not enough history yet. Go make some memories first.'); return; }
  const split = Math.round((w.mine / w.total) * 100);
  const openerLine = w.iOpened > w.theyOpened
    ? `You text first ${w.iOpened}–${w.theyOpened}. Down bad, respectfully.`
    : w.iOpened < w.theyOpened
      ? `They text first ${w.theyOpened}–${w.iOpened}. You're the prize, apparently.`
      : `Dead even on who texts first. Soulmate behavior.`;
  root.innerHTML = `
  <div class="palette-veil" id="wr-veil">
    <div class="wrapped-card">
      <div class="wr-head">${icon('sparkle', 20)}<div><b>Friendship Wrapped</b><div class="wr-sub">you × ${esc(w.name)}</div></div>
        <button class="btn ghost small" id="wr-close" style="margin-left:auto">${icon('x', 12)}</button></div>
      <div class="wr-line">Together since <b>${new Date(w.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</b></div>
      <div class="dna-grid" style="margin-top:12px">
        <div class="dna-stat"><div class="v">${w.total}</div><div class="k">MESSAGES</div></div>
        <div class="dna-stat"><div class="v">${w.streak >= 2 ? w.streak + 'd' : '—'}</div><div class="k">STREAK</div></div>
        <div class="dna-stat" title="voice & video days only"><div class="v">${w.vibeStreak >= 2 ? w.vibeStreak + 'd' : '—'}</div><div class="k">VIBE CHECK</div></div>
        <div class="dna-stat"><div class="v">${w.peakHour}:00</div><div class="k">CHAOS HOUR</div></div>
        ${w.memories ? `<div class="dna-stat"><div class="v">${w.memories}</div><div class="k">MEMORIES</div></div>` : ''}
        ${w.promisesKept ? `<div class="dna-stat"><div class="v">${w.promisesKept}</div><div class="k">PROMISES KEPT</div></div>` : ''}
      </div>
      <div class="wr-split"><div style="width:${split}%"></div></div>
      <div class="wr-line faintline">the yap ratio: you ${split}% · them ${100 - split}%</div>
      <div class="wr-line">${icon('send', 13, 'accent')} ${esc(openerLine)}</div>
      <div class="wr-line">${icon('clock', 13, 'accent')} Reply speed — you: <b>${esc(w.myGhost)}</b> · them: <b>${esc(w.theirGhost)}</b></div>
      ${w.topWord ? `<div class="wr-line">${icon('message', 13, 'accent')} Your word of the era: <b>“${esc(w.topWord)}”</b></div>` : ''}
      <div style="display:flex;justify-content:center;margin-top:14px">
        <button class="btn small" id="wr-replay">${icon('sparkle', 13)} Replay the vibes</button>
      </div>
      <div class="faint" style="margin-top:12px;text-align:center">computed locally from your own history · zero judgement (some judgement)</div>
    </div>
  </div>`;
  $('#wr-close').onclick = close;
  $('#wr-veil').onmousedown = e => { if (e.target.id === 'wr-veil') close(); };
  $('#wr-replay').onclick = () => { close(); showReplay(); };
  runEffect('confetti');
}

/* ---- Memory Vibe Replay: Wrapped's best moments as an animated reel --------- */
async function showReplay() {
  if (!S.chat?.other) return;
  const d = await api(`/people/${S.chat.other.other_id}/replay`).catch(() => null);
  if (!d || d.tooEarly) return toast('Not enough history for a replay yet. Go live a little.');
  const root = $('#palette-root');
  let i = 0, timer = null;
  const close = () => { clearTimeout(timer); root.innerHTML = ''; };
  const DUR = 3200;

  const slideHtml = s => {
    if (s.kind === 'intro') return `${icon('sparkle', 40, 'accent')}<div class="rp-title pop">${esc(s.title)}</div><div class="rp-sub pop d2">${esc(s.sub)}</div>`;
    if (s.kind === 'outro') return `<div class="rp-title pop">${esc(s.title)}</div><div class="rp-sub pop d2">${esc(s.sub)}</div>`;
    if (s.kind === 'stat') return `
      <div class="rp-label pop">${esc(s.label)}</div>
      <div class="rp-big pop d2">${esc(s.big)}</div>
      ${s.sub ? `<div class="rp-sub pop d3">${esc(s.sub)}</div>` : ''}`;
    return `
      <div class="rp-label pop">${esc(s.label)}</div>
      <div class="rp-quote pop d2">“${esc(s.body)}”</div>
      <div class="rp-sub pop d3">— ${esc(s.from)}, ${new Date(s.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${s.reactions ? ` · ${s.reactions} reaction${s.reactions === 1 ? '' : 's'}` : ''}</div>`;
  };

  const draw = () => {
    clearTimeout(timer);
    root.innerHTML = `
    <div class="palette-veil replay-veil" id="rp-veil">
      <div class="replay-stage" id="rp-stage">
        <div class="rp-dots">${d.slides.map((_, j) => `<span class="${j <= i ? 'on' : ''}"></span>`).join('')}</div>
        <div class="rp-body">${slideHtml(d.slides[i])}</div>
        <div class="rp-foot">
          <button class="btn ghost small" id="rp-share" title="Download a shareable poster">${icon('image', 13)} Share poster</button>
          <span class="faint" style="flex:1;text-align:center">tap to skip</span>
          <button class="btn ghost small" id="rp-close">${icon('x', 12)}</button>
        </div>
      </div>
    </div>`;
    $('#rp-close').onclick = close;
    $('#rp-share').onclick = e => { e.stopPropagation(); shareReplayPoster(d); };
    $('#rp-stage').onclick = () => { if (i < d.slides.length - 1) { i++; draw(); } else close(); };
    if (i < d.slides.length - 1) timer = setTimeout(() => { i++; draw(); }, DUR);
  };
  draw();
}

/** Canvas poster: the reel condensed into one shareable PNG. All on-device. */
function shareReplayPoster(d) {
  const W = 900, H = 1600;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#141126'); g.addColorStop(1, '#241a3d');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (const [cx, cy, r, col] of [[120, 220, 260, 'rgba(124,140,255,.16)'], [780, 640, 300, 'rgba(192,110,247,.13)'], [240, 1350, 320, 'rgba(52,227,194,.10)']]) {
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, col); rg.addColorStop(1, 'transparent');
    x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
  }
  x.textAlign = 'center'; x.fillStyle = 'rgba(255,255,255,.55)';
  x.font = '600 34px system-ui'; x.letterSpacing = '8px';
  x.fillText('MEMORY VIBE REPLAY', W / 2, 170);
  x.letterSpacing = '0px'; x.fillStyle = '#fff';
  x.font = '800 72px system-ui';
  x.fillText(`${d.myName.split(' ')[0]} × ${d.name.split(' ')[0]}`, W / 2, 320);
  const rows = [
    [String(d.total), 'messages'],
    ...(d.vibeStreak >= 2 ? [[d.vibeStreak + 'd', 'vibe check streak']] : d.streak >= 2 ? [[d.streak + 'd', 'streak']] : []),
    ...(d.topWord ? [[`“${d.topWord}”`, 'word of the era']] : []),
  ];
  let y = 560;
  for (const [big, label] of rows) {
    x.fillStyle = '#a5b4ff'; x.font = '800 120px system-ui';
    x.fillText(big.length > 10 ? big.slice(0, 10) + '…' : big, W / 2, y);
    x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '600 36px system-ui';
    x.fillText(label, W / 2, y + 62);
    y += 300;
  }
  x.fillStyle = 'rgba(255,255,255,.75)'; x.font = '700 40px system-ui';
  x.fillText('the vibes were real', W / 2, H - 200);
  x.fillStyle = 'rgba(255,255,255,.4)'; x.font = '600 30px system-ui';
  x.fillText('△ Ikvizz', W / 2, H - 120);
  c.toBlob(async blob => {
    const file = new File([blob], 'vibe-replay.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Memory Vibe Replay' }); return; } catch { /* fell through to download */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vibe-replay.png';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${icon('image', 14, 'accent')} Poster saved — post it anywhere.`);
  }, 'image/png');
}

/* ---- Rizz Battle: same scenario, one line each, the judge decides ------------ */
async function showRizz(other) {
  const root = $('#palette-root');
  let timer = null;
  const close = () => { clearInterval(timer); root.innerHTML = ''; };

  const draw = async () => {
    const d = await api('/rizz').catch(() => ({ battles: [] }));
    const b = d.battles.find(x => x.challenger.id === other.other_id || x.opponent.id === other.other_id);
    const first = other.display_name.split(' ')[0];
    let bodyHtml;
    const challengeBtn = `<button class="btn" id="rz-new" style="width:100%">${icon('crown', 14)} Challenge ${esc(first)} to a Rizz Battle</button>`;
    if (!b) {
      bodyHtml = `<div class="faint" style="margin-bottom:12px">One scenario. One line each. Ollama judges if it's running — an honest points system if not. Winner is Rizz King for 24 hours.</div>${challengeBtn}`;
    } else if (b.status === 'active') {
      bodyHtml = `
        <div class="rz-scenario">${icon('zap', 14, 'accent')} ${esc(b.scenario)}</div>
        ${b.my_turn ? `
          <textarea class="input" id="rz-line" rows="2" placeholder="cook. one line. make it count…" maxlength="280"></textarea>
          <button class="btn small" id="rz-send" style="margin-top:8px;width:100%">${icon('send', 13)} Lock it in</button>`
        : `<div class="note-card" style="margin-top:10px">${icon('check', 14, 'ok')}<div style="flex:1">Your line is locked in: <b>${esc(b.my_line)}</b></div></div>`}
        <div class="faint" style="margin-top:10px">${b.their_submitted ? `${esc(first)} has cooked. ` : `Waiting on ${esc(first)}… `}${b.my_turn ? 'Your move.' : b.their_submitted ? 'Judging…' : 'The judge waits for both lines.'}</div>`;
    } else {
      const won = b.won;
      bodyHtml = `
        <div class="rz-scenario">${icon('zap', 14, 'accent')} ${esc(b.scenario)}</div>
        <div class="rz-result ${won ? 'won' : 'lost'}">${icon('crown', 26, won ? 'accent' : 'dim')}
          <b>${won ? 'You are the Rizz King' : `${esc(first)} took the crown`}</b>
          <span class="faint">24-hour reign · judged ${timeAgo(b.judged_at)} ago</span>
        </div>
        <div class="rz-line mine"><b>you</b> ${esc(b.my_line || '—')}</div>
        <div class="rz-line"><b>${esc(first)}</b> ${esc(b.their_line || '—')}</div>
        <div class="note-card" style="margin-top:10px">${icon('sparkle', 14, 'accent')}
          <div style="flex:1;white-space:normal"><b>Verdict:</b> ${esc(b.verdict || '')}<div class="faint" style="margin-top:3px">judge: ${esc(b.engine || 'heuristic')} · local, honest</div></div>
        </div>
        <div style="margin-top:12px">${challengeBtn.replace('Challenge', 'Rematch:')}</div>`;
    }
    root.innerHTML = `
    <div class="palette-veil" id="rz-veil"><div class="palette" style="padding:18px 20px;max-width:520px">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px">
        ${icon('crown', 18, 'accent')}<b>Rizz Battle</b>
        <span class="faint" style="flex:1">you × ${esc(first)}</span>
        <button class="btn ghost small" id="rz-close">${icon('x', 12)}</button>
      </div>
      ${bodyHtml}
    </div></div>`;
    $('#rz-close').onclick = close;
    $('#rz-veil').onmousedown = e => { if (e.target.id === 'rz-veil') close(); };
    const newBtn = $('#rz-new');
    if (newBtn) newBtn.onclick = async () => {
      try { await api('/rizz', { body: { otherId: other.other_id } }); draw(); }
      catch (e) { toast(esc(e.message), true); }
    };
    const sendBtn = $('#rz-send');
    if (sendBtn) sendBtn.onclick = async () => {
      const line = $('#rz-line').value.trim();
      if (!line) return;
      try {
        const r = await api(`/rizz/${b.id}/line`, { body: { line } });
        if (r.battle.status === 'judged') { refreshPeople().then(renderChatHead).catch(() => {}); runEffect(r.battle.won ? 'confetti' : 'shake'); }
        draw();
      } catch (e) { toast(esc(e.message), true); }
    };
  };
  await draw();
  timer = setInterval(() => {
    if (!$('#rz-veil')) return clearInterval(timer);
    if (document.activeElement?.id === 'rz-line' && document.activeElement.value) return; // don't eat the line mid-cook
    draw();
  }, 4000);
}

function scrollMsgs() { const b = $('#msgs'); if (b) b.scrollTop = b.scrollHeight; }

/* Intent Engine (client side): stream lightweight telemetry, not keystrokes. */
function wireComposer() {
  const ta = $('#composer');
  const draftKey = 'aether_draft_' + S.chat.conversationId;
  const saved = localStorage.getItem(draftKey);
  if (saved) { ta.value = saved; setTimeout(() => ta.dispatchEvent(new Event('input')), 0); }

  const emitSend = payload => S.socket.emit('message:send', { conversationId: S.chat.conversationId, ...payload }, (res) => {
    if (!res?.ok) toast(esc(res?.error || 'Could not send'), true);
    // Own echo comes via message:new (we're in the room) — nothing else to do.
  });

  // Slash commands: /confetti /shake effects · /silent (never interrupts) ·
  // /capsule YYYY-MM-DD (time capsule) · /shrug /tableflip /unflip
  const FACES = { shrug: '¯\\_(ツ)_/¯', tableflip: '(╯°□°)╯︵ ┻━┻', unflip: '┬─┬ノ( º _ ºノ)' };
  const parseSlash = raw => {
    let body = raw, effect = null, silent = false, unlockAt = null, bad = null;
    const eff = body.match(/^\/(confetti|shake|flip)\s+([\s\S]+)/i);
    if (eff) { effect = eff[1].toLowerCase(); body = eff[2]; }
    if (/^\/silent\s+/i.test(body)) { silent = true; body = body.replace(/^\/silent\s+/i, ''); }
    const cap = body.match(/^\/capsule\s+(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)\s+([\s\S]+)/i);
    if (cap) {
      const at = new Date(cap[1].length === 4 ? cap[1] + '-01-01' : cap[1]).getTime();
      if (!Number.isFinite(at) || at <= Date.now()) bad = 'Capsule date must be a future date, like /capsule 2035-01-01 your message';
      else { unlockAt = at; body = cap[2]; }
    } else if (/^\/capsule\b/i.test(body)) bad = 'Usage: /capsule 2035-01-01 your message';
    let poll = null;
    const pm = body.match(/^\/poll\s+([\s\S]+)/i);
    if (pm) {
      const parts = pm[1].split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 3) { body = parts[0]; poll = parts.slice(1); }
      else bad = 'Usage: /poll Question | option one | option two';
    }
    const face = body.match(/^\/(shrug|tableflip|unflip)\b\s*/i);
    if (face) body = (body.slice(face[0].length).trim() + ' ' + FACES[face[1].toLowerCase()]).trim();
    return { body: body.trim(), effect, silent, unlockAt, bad, poll };
  };

  // AI Conflict Resolver: a private nudge BEFORE a harsh message leaves you.
  // You always decide — it never blocks twice.
  const looksHarsh = t => {
    const letters = t.replace(/[^a-zA-Z]/g, '');
    const shouting = letters.length > 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.72;
    return shouting || /!{3,}/.test(t)
      || /\b(shut up|stupid|idiot|hate you|useless|dumbest|screw you|worst person|whatever man)\b/i.test(t)
      || /\byou (always|never)\b/i.test(t);
  };

  const send = async () => {
    const parsed = parseSlash(ta.value.trim());
    if (parsed.bad) return toast(esc(parsed.bad), true);
    const body = parsed.body, effect = parsed.effect;
    if (!body) return;

    if (!S.chat.harshOk && looksHarsh(body) && !S.chat.editing) {
      $('#composer-note').innerHTML = `<div class="note-card" style="border-left-color:var(--important)">
        ${icon('alert', 14, 'important')}
        <div style="flex:1;white-space:normal">This might land harsher than you mean it. Sleep on it, soften it — or send it anyway, your call.</div>
        <button class="btn ghost small" id="harsh-send">Send anyway</button>
        <button class="btn small" id="harsh-edit">Let me rephrase</button>
      </div>`;
      $('#harsh-send').onclick = () => { S.chat.harshOk = true; renderComposerNote(); send(); };
      $('#harsh-edit').onclick = () => { renderComposerNote(); ta.focus(); };
      return;
    }
    S.chat.harshOk = false;

    const wasEditing = S.chat.editing;
    const replyTo = S.chat.replyTo?.id || null;
    const moodTag = S.chat.moodTag || null;
    S.chat.moodTag = null;
    const moodBtn = $('#mood-btn');
    if (moodBtn) { moodBtn.innerHTML = icon('smile', 17); moodBtn.classList.remove('on'); }
    ta.value = ''; ta.style.height = 'auto';
    localStorage.removeItem(draftKey);
    S.chat.replyTo = null; S.chat.editing = null;
    renderComposerNote();
    S.socket.emit('intent', { conversationId: S.chat.conversationId, stopped: true });

    if (wasEditing) {
      S.socket.emit('message:edit', { messageId: wasEditing, body }, r => { if (!r?.ok) toast(esc(r?.error || 'Could not edit'), true); });
      return;
    }
    if (S.chat.sealMode && S.chat.other) {
      try {
        const key = await dmKey(S.chat.other.other_id, S.chat.otherPub);
        emitSend({ kind: 'sealed', body: await sealText(body, key), replyTo });
      } catch { toast('Could not encrypt — sending cancelled.', true); ta.value = body; }
    } else {
      emitSend({ body, replyTo, effect, silent: parsed.silent, unlockAt: parsed.unlockAt, mood: moodTag, pollOptions: parsed.poll });
    }
  };
  $('#send-btn').onclick = send;

  // Emotion Layer: tag the message with an Ikvizz mood — say how you mean it
  const moodBtn = $('#mood-btn');
  if (moodBtn) moodBtn.onclick = e => {
    e.stopPropagation();
    const existing = $('#mood-pop');
    if (existing) return existing.remove();
    moodBtn.insertAdjacentHTML('beforebegin', `
      <div class="mood-pop" id="mood-pop">
        <div class="faint" style="padding:2px 6px 6px">how do you mean it?</div>
        <div class="mood-row">${MOOD_KINDS.map(k => `<button data-mood="${k}" title="${MOODS[k].label}">${mood(k, 30)}</button>`).join('')}</div>
      </div>`);
    $('#mood-pop').querySelectorAll('[data-mood]').forEach(b => b.onclick = () => {
      S.chat.moodTag = b.dataset.mood;
      moodBtn.innerHTML = mood(b.dataset.mood, 22);
      moodBtn.classList.add('on');
      $('#mood-pop').remove();
      ta.focus();
    });
  };

  // Voice notes — recorded in-app, stored locally like any attachment
  let recorder = null, recChunks = [], recTimer = null, recStart = 0;
  const emojiBtn = $('#emoji-btn');
  if (emojiBtn) emojiBtn.onclick = e => { e.stopPropagation(); toggleEmojiPanel(); };
  // The "+" tray: one tap reveals photos, camera, location, mood, seal, song bomb.
  const plusBtn = $('#plus-btn'), tray = $('#plus-tray');
  const closeTray = () => { if (tray) tray.hidden = true; plusBtn?.classList.remove('on'); };
  if (plusBtn) plusBtn.onclick = e => {
    e.stopPropagation();
    tray.hidden = !tray.hidden;
    plusBtn.classList.toggle('on', !tray.hidden);
  };
  tray?.querySelectorAll('.tray-item').forEach(b => b.addEventListener('click', closeTray));
  document.addEventListener('click', e => { if (tray && !tray.hidden && !e.target.closest('#plus-tray') && !e.target.closest('#plus-btn')) closeTray(); });
  const pollBtn = $('#poll-btn');
  if (pollBtn) pollBtn.onclick = () => showPollBuilder(emitSend);
  const camBtn = $('#camera-btn');
  if (camBtn) camBtn.onclick = () => openCamera(emitSend);
  const locBtn = $('#loc-btn');
  if (locBtn) locBtn.onclick = () => chooseLocation(emitSend); // ask current vs live first
  const songBomb = $('#songbomb-btn');
  if (songBomb) songBomb.onclick = () => startMusicSync(); // dedicate a track + listen together
  const micBtn = $('#mic-btn');
  const stopRecording = () => { try { recorder?.stop(); } catch { } };
  micBtn.onclick = async () => {
    if (recorder && recorder.state === 'recording') return stopRecording();
    if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone not available in this browser.', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
      recorder.onstop = async () => {
        clearInterval(recTimer);
        micBtn.classList.remove('rec');
        micBtn.innerHTML = icon('mic', 17);
        $('#composer-note').innerHTML = '';
        renderComposerNote();
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 1200) return; // accidental tap
        if (blob.size > 8 * 1024 * 1024) return toast('Voice note too long (max 8 MB).', true);
        toast(`${icon('mic', 14)} Sending voice note…`);
        try {
          const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
          const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
          const att = await api('/upload', { body: { name: `voice-note.${ext}`, type: blob.type.split(';')[0], dataBase64: String(dataUrl).split(',')[1] } });
          emitSend({ body: '', attachment: att });
        } catch (e) { toast(esc(e.message), true); }
      };
      recorder.start();
      recStart = Date.now();
      micBtn.classList.add('rec');
      micBtn.innerHTML = icon('stop', 17);
      const tick = () => {
        const s = Math.floor((Date.now() - recStart) / 1000);
        $('#composer-note').innerHTML = `<div class="note-card rec-note">${icon('mic', 13, 'critical')} Recording… <b>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</b><div style="flex:1"></div><button class="btn ghost small" id="rec-stop">${icon('stop', 11)} Stop & send</button></div>`;
        $('#rec-stop').onclick = stopRecording;
      };
      tick();
      recTimer = setInterval(tick, 1000);
    } catch { toast('Microphone permission denied.', true); }
  };

  // 📎 media sharing — uploaded locally, linked into the conversation
  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async () => {
    const file = $('#file-input').files[0];
    $('#file-input').value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('Max file size is 8 MB.', true);
    toast(`${icon('paperclip', 14)} Uploading ${esc(file.name)}…`);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(file);
      });
      const att = await api('/upload', { body: { name: file.name, type: file.type, dataBase64: String(dataUrl).split(',')[1] } });
      emitSend({ body: ta.value.trim(), attachment: att });
      ta.value = ''; ta.style.height = 'auto';
    } catch (e) { toast(esc(e.message), true); }
  };

  // 🔒 seal toggle — real E2E; the brain deliberately goes blind on these
  const sealBtn = $('#seal-btn');
  if (sealBtn) sealBtn.onclick = () => {
    if (!S.privKey) return toast('Encryption keys not ready on this device yet.', true);
    if (!S.chat.otherPub) return toast(`${esc(S.chat.other.display_name.split(' ')[0])} hasn't opened Ikvizz since encryption arrived — no key published yet.`, true);
    S.chat.sealMode = !S.chat.sealMode;
    sealBtn.innerHTML = icon(S.chat.sealMode ? 'lock' : 'unlock', 17);
    sealBtn.classList.toggle('on', S.chat.sealMode);
    ta.placeholder = S.chat.sealMode
      ? 'Sealed — end-to-end encrypted. Not even the brain reads this.'
      : 'Say something worth remembering…';
    ta.focus();
  };

  let lastKey = 0, deleted = false, idleTimer = null, throttle = 0;
  const emitIntent = (extra = {}) => {
    S.socket.emit('intent', {
      conversationId: S.chat.conversationId,
      draftLength: ta.value.length,
      msSinceKeystroke: Date.now() - lastKey,
      deletedRecently: deleted,
      ...extra,
    });
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { deleted = true; setTimeout(() => deleted = false, 6000); }
  });
  ta.addEventListener('input', () => {
    lastKey = Date.now();
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
    // Drafts survive navigation — half-written thoughts are still thoughts
    if (!S.chat.editing) {
      if (ta.value) localStorage.setItem(draftKey, ta.value);
      else localStorage.removeItem(draftKey);
    }
    if (Date.now() - throttle > 900) { throttle = Date.now(); emitIntent(); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ta.value ? emitIntent() : emitIntent({ stopped: true }), 4500);
  });
  ta.addEventListener('blur', () => { if (!ta.value) emitIntent({ stopped: true }); });
  ta.focus();
}

function setIntent(userId, intent) {
  if (!S.chat) return;
  S.chat.intents[userId] = intent;
  clearTimeout(S.intentTimers[userId]);
  if (intent) S.intentTimers[userId] = setTimeout(() => setIntent(userId, null), 8000);
  const line = $('#intent-line');
  if (!line) return;
  const active = Object.entries(S.chat.intents).filter(([, v]) => v);
  if (!active.length) { line.innerHTML = ''; return; }
  const bits = active.map(([uid, word]) => {
    const who = S.chat.other?.other_id === Number(uid)
      ? S.chat.other.display_name.split(' ')[0]
      : S.chat.spaceMeta?.members.find(m => m.id === Number(uid))?.display_name.split(' ')[0] || 'Someone';
    return `<b>${esc(who)}</b> is ${INTENT_WORDS[word] || 'writing…'}`;
  });
  line.innerHTML = `<span class="pulse"></span> ${bits.join(' · ')}`;
}

/* Location — ask first (WhatsApp-style): current vs live, or cancel. Free stack:
   browser Geolocation + OpenStreetMap, no key, no billing. */
function chooseLocation(emitSend) {
  if (!navigator.geolocation) return toast('Location not available in this browser.', true);
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="loc-veil"><div class="palette" style="padding:18px 20px;max-width:420px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:6px">${icon('mappin', 18, 'accent')}<b>Share location</b>
      <button class="btn ghost small" id="loc-x" style="margin-left:auto">${icon('x', 12)}</button></div>
    <div class="faint" style="margin-bottom:12px">Nothing is sent until you choose.</div>
    <button class="loc-choice" id="loc-current">${icon('mappin', 18, 'accent')}<div><b>Current location</b><span>Send where you are right now</span></div></button>
    <button class="loc-choice" id="loc-live">${icon('pulse', 18, 'accent')}<div><b>Live location</b><span>Share your live position for 15 minutes</span></div></button>
  </div></div>`;
  $('#loc-x').onclick = close;
  $('#loc-veil').onmousedown = e => { if (e.target.id === 'loc-veil') close(); };
  $('#loc-current').onclick = () => {
    close();
    toast(`${icon('mappin', 14, 'accent')} Sending your location…`);
    // Fast path: accept a recent cached fix so it sends near-instantly; only
    // wait for GPS if we have nothing cached.
    navigator.geolocation.getCurrentPosition(
      pos => emitSend({ body: '', location: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
      err => toast(err.code === 1 ? 'Location permission denied.' : 'Could not get your location.', true),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
    );
  };
  $('#loc-live').onclick = () => { close(); chooseLiveDuration(); };
}

/* Live location asks HOW LONG first (15 / 30 / 45 min — WhatsApp-style). */
function chooseLiveDuration() {
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="dur-veil"><div class="palette" style="padding:18px 20px;max-width:400px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:6px">${icon('pulse', 18, 'accent')}<b>Live location</b>
      <button class="btn ghost small" id="dur-x" style="margin-left:auto">${icon('x', 12)}</button></div>
    <div class="faint" style="margin-bottom:12px">Share your live position for how long?</div>
    <div class="dur-row">
      <button class="dur-choice" data-min="15">15 min</button>
      <button class="dur-choice" data-min="30">30 min</button>
      <button class="dur-choice" data-min="45">45 min</button>
    </div>
  </div></div>`;
  $('#dur-x').onclick = close;
  $('#dur-veil').onmousedown = e => { if (e.target.id === 'dur-veil') close(); };
  root.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { close(); startLiveLocation(Number(b.dataset.min)); });
}

/* Poll builder — question + up to 4 options, sent as a real poll. */
function showPollBuilder(emitSend) {
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="poll-veil"><div class="palette" style="padding:18px 20px;max-width:440px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px">${icon('checkCircle', 18, 'accent')}<b>Create a poll</b>
      <button class="btn ghost small" id="poll-x" style="margin-left:auto">${icon('x', 12)}</button></div>
    <input class="input" id="poll-q" placeholder="Ask a question…" maxlength="120" style="margin-bottom:10px"/>
    <input class="input poll-opt" placeholder="Option 1" maxlength="80" style="margin-bottom:8px"/>
    <input class="input poll-opt" placeholder="Option 2" maxlength="80" style="margin-bottom:8px"/>
    <input class="input poll-opt" placeholder="Option 3 (optional)" maxlength="80" style="margin-bottom:8px"/>
    <input class="input poll-opt" placeholder="Option 4 (optional)" maxlength="80" style="margin-bottom:12px"/>
    <button class="btn" id="poll-send" style="width:100%">${icon('send', 14)} Send poll</button>
  </div></div>`;
  $('#poll-x').onclick = close;
  $('#poll-veil').onmousedown = e => { if (e.target.id === 'poll-veil') close(); };
  $('#poll-q').focus();
  $('#poll-send').onclick = () => {
    const q = $('#poll-q').value.trim();
    const opts = [...root.querySelectorAll('.poll-opt')].map(i => i.value.trim()).filter(Boolean);
    if (!q) return toast('Add a question.', true);
    if (opts.length < 2) return toast('Add at least two options.', true);
    emitSend({ body: q, pollOptions: opts });
    close();
  };
}

/* Live location — sends an initial pin, then streams position updates for 15 min
   (or until you stop). Each update patches the same message so the pin moves. */
const LIVE = { watchId: null, messageId: null, timer: null };
function stopLiveLocation(silent) {
  if (LIVE.watchId !== null) navigator.geolocation.clearWatch(LIVE.watchId);
  clearTimeout(LIVE.timer);
  const banner = $('#live-loc-banner'); if (banner) banner.remove();
  if (LIVE.messageId && !silent) S.socket.emit('location:update', { messageId: LIVE.messageId, stop: true });
  LIVE.watchId = null; LIVE.messageId = null; LIVE.timer = null;
}
function startLiveLocation(minutes = 15) {
  if (LIVE.messageId) return toast('Already sharing live location.', true);
  toast(`${icon('pulse', 14, 'accent')} Starting live location…`);
  navigator.geolocation.getCurrentPosition(pos => {
    // Send the first pin; capture its id from the ack so updates can patch it.
    S.socket.emit('message:send', {
      conversationId: S.chat.conversationId, body: '',
      location: { lat: pos.coords.latitude, lng: pos.coords.longitude, live: true },
    }, res => {
      if (!res?.ok) return toast(esc(res?.error || 'Could not start live location.'), true);
      LIVE.messageId = res.message.id;
      showLiveBanner(minutes);
      LIVE.watchId = navigator.geolocation.watchPosition(
        p => S.socket.emit('location:update', { messageId: LIVE.messageId, lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {}, { enableHighAccuracy: true, maximumAge: 15000 },
      );
      LIVE.timer = setTimeout(() => { stopLiveLocation(); toast('Live location ended.'); }, minutes * 60_000);
    });
  }, err => toast(err.code === 1 ? 'Location permission denied.' : 'Could not get your location.', true),
    { enableHighAccuracy: true, timeout: 10000 });
}
function showLiveBanner(minutes) {
  $('#live-loc-banner')?.remove();
  const bar = document.createElement('div');
  bar.id = 'live-loc-banner'; bar.className = 'note-card live-loc';
  bar.innerHTML = `${icon('pulse', 14, 'accent')}<div style="flex:1">Sharing live location · ${minutes} min</div><button class="btn ghost small" id="live-stop">Stop</button>`;
  $('#composer-note')?.after(bar);
  $('#live-stop').onclick = () => { stopLiveLocation(); toast('Stopped sharing live location.'); };
}

/** Render a shared location as a free OpenStreetMap embed + "open in maps" link. */
function locationHtml(loc) {
  const { lat, lng } = loc;
  const d = 0.008; // bbox padding
  const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
  const open = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  return `<div class="loc-card">
    <iframe class="loc-map" src="${embed}" loading="lazy" referrerpolicy="no-referrer" title="Shared location"></iframe>
    <a class="loc-open" href="${open}" target="_blank" rel="noopener">${icon('mappin', 13)} ${lat.toFixed(4)}, ${lng.toFixed(4)} · open in maps</a>
  </div>`;
}

/* In-chat camera — snap a photo and send it, without leaving the chat. */
async function openCamera(emitSend) {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera not available in this browser.', true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }); }
  catch { return toast('Camera permission denied.', true); }
  const root = $('#palette-root');
  const isDm = S.chat?.convo?.kind === 'dm';
  let viewOnce = false;
  const close = () => { stream.getTracks().forEach(t => t.stop()); root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="cam-veil"><div class="cam-card">
    <video id="cam-video" autoplay playsinline></video>
    <canvas id="cam-canvas" hidden></canvas>
    ${isDm ? `<button class="cam-vo" id="cam-vo" title="View once — disappears after they open it">${icon('eye', 15)}<span>View once</span></button>` : ''}
    <div class="cam-acts">
      <button class="btn ghost round" id="cam-flip" title="Flip camera">${icon('camera', 18)}</button>
      <button class="btn round cam-shoot" id="cam-shoot" title="Capture"></button>
      <button class="btn ghost round" id="cam-close" title="Close">${icon('x', 18)}</button>
    </div>
  </div></div>`;
  const video = $('#cam-video');
  video.srcObject = stream;
  let facing = 'user';
  $('#cam-veil').onmousedown = e => { if (e.target.id === 'cam-veil') close(); };
  $('#cam-close').onclick = close;
  $('#cam-vo')?.addEventListener('click', () => {
    viewOnce = !viewOnce;
    $('#cam-vo').classList.toggle('on', viewOnce);
  });
  $('#cam-flip').onclick = async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    stream.getTracks().forEach(t => t.stop());
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); video.srcObject = stream; }
    catch { /* only one camera */ }
  };
  $('#cam-shoot').onclick = async () => {
    const c = $('#cam-canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    if (facing === 'user') { const x = c.getContext('2d'); x.translate(c.width, 0); x.scale(-1, 1); } // mirror selfie
    c.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    close();
    toast(`${icon('camera', 14)} Sending photo…`);
    try {
      const up = await api('/upload', { body: { name: 'photo.jpg', type: 'image/jpeg', dataBase64: dataUrl.split(',')[1] } });
      emitSend({ body: '', attachment: up, viewOnce });
    } catch (e) { toast(esc(e.message), true); }
  };
}

/* ── Avatar creator (Snapchat/Bitmoji-style, layered SVG) ── */
const AV_CATS = [
  { key: 'face', label: 'Face', type: 'shape' },
  { key: 'skin', label: 'Skin', type: 'color', colors: AV.skin },
  { key: 'hair', label: 'Hair', type: 'shape' },
  { key: 'hairColor', label: 'Hair color', type: 'color', colors: AV.hairColor },
  { key: 'eyes', label: 'Eyes', type: 'shape' },
  { key: 'brows', label: 'Brows', type: 'shape' },
  { key: 'mouth', label: 'Mouth', type: 'shape' },
  { key: 'beard', label: 'Beard', type: 'shape' },
  { key: 'glasses', label: 'Glasses', type: 'shape' },
  { key: 'bg', label: 'Backdrop', type: 'color', colors: AV.bg },
];

function openAvatarCreator() {
  const root = $('#palette-root');
  let cfg = { ...(parseAvatarConfig(S.me.avatar_config) || AV_DEFAULT) };
  let activeCat = 'face';
  const close = () => { root.innerHTML = ''; };

  const optsHtml = () => {
    const cat = AV_CATS.find(c => c.key === activeCat);
    const count = AV[cat.key].length;
    return Array.from({ length: count }, (_, i) => {
      const on = cfg[cat.key] === i ? 'on' : '';
      if (cat.type === 'color') {
        return `<button class="av-opt color ${on}" data-opt="${i}" style="--sw:${cat.colors[i]}" title="${esc(AV[cat.key][i])}"></button>`;
      }
      // Shape option → a mini avatar with just this field swapped, so the effect is obvious
      return `<button class="av-opt ${on}" data-opt="${i}" title="${esc(AV[cat.key][i])}">${buildAvatar({ ...cfg, [cat.key]: i })}</button>`;
    }).join('');
  };

  const render = () => {
    root.innerHTML = `
    <div class="palette-veil" id="av-veil"><div class="palette av-creator">
      <div class="av-head">
        <b>${icon('smile', 18, 'accent')} Make your avatar</b>
        <button class="btn ghost small" id="av-x" aria-label="Close">${icon('x', 12)}</button>
      </div>
      <div class="av-stage"><div class="av-preview">${buildAvatar(cfg)}</div></div>
      <div class="av-cats">${AV_CATS.map(c => `<button class="av-cat ${c.key === activeCat ? 'on' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}</div>
      <div class="av-opts">${optsHtml()}</div>
      <div class="av-actions">
        <button class="btn ghost" id="av-rand">${icon('sparkle', 14)} Surprise me</button>
        <button class="btn" id="av-save">${icon('check', 14)} Save avatar</button>
      </div>
    </div></div>`;
    $('#av-x').onclick = close;
    $('#av-veil').onmousedown = e => { if (e.target.id === 'av-veil') close(); };
    root.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { activeCat = b.dataset.cat; render(); });
    root.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { cfg[activeCat] = Number(b.dataset.opt); render(); });
    $('#av-rand').onclick = () => {
      AV_CATS.forEach(c => { cfg[c.key] = Math.floor(Math.random() * AV[c.key].length); });
      render();
    };
    $('#av-save').onclick = async () => {
      try {
        const d = await api('/me/avatar', { method: 'PATCH', body: { config: cfg } });
        S.me = { ...S.me, avatar_config: d.user.avatar_config, avatar_url: d.user.avatar_url };
        toast(`${icon('check', 14, 'ok')} Avatar saved.`);
        close(); renderShell(); renderMe();
      } catch (e) { toast(esc(e.message), true); }
    };
  };
  render();
}

/* Per-chat mood backgrounds — pick one, saved locally per conversation. */
const CHAT_BACKGROUNDS = [
  ['', 'Default', 'var(--bg)'],
  ['peachdream', 'Peach Dream', 'linear-gradient(160deg,#ffe3d0,#ffd0e0 55%,#e6d0ff)'],
  ['mintcalm', 'Mint Calm', 'linear-gradient(160deg,#d8f5e6,#d0eeff 60%,#eafbe0)'],
  ['dusk', 'Dusk', 'linear-gradient(160deg,#3a3358,#52426f 55%,#6a4a6e)'],
  ['paper', 'Paper', '#f6f1ea'],
  ['focus', 'Focus', 'linear-gradient(180deg,#eef1f7,#e7ebf3)'],
];
function showBgPicker() {
  if (!S.chat) return;
  const cur = localStorage.getItem('aether_bg_' + S.chat.conversationId) || '';
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="bg-veil"><div class="palette" style="padding:18px 20px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:14px">${icon('image', 17, 'accent')}<b>Chat background</b>
      <span class="faint" style="flex:1">just this conversation</span>
      <button class="btn ghost small" id="bg-close">${icon('x', 12)}</button></div>
    <div class="bg-picker">
      ${CHAT_BACKGROUNDS.map(([k, label, css]) => `<div style="text-align:center">
        <div class="bg-swatch ${cur === k ? 'sel' : ''}" data-bg-set="${k}" style="background:${css}"></div>
        <div class="faint" style="margin-top:4px;font-size:10.5px">${label}</div></div>`).join('')}
    </div>
  </div></div>`;
  $('#bg-close').onclick = close;
  $('#bg-veil').onmousedown = e => { if (e.target.id === 'bg-veil') close(); };
  root.querySelectorAll('[data-bg-set]').forEach(b => b.onclick = () => {
    const k = b.dataset.bgSet;
    const msgs = $('#msgs');
    if (k) { msgs.dataset.bg = k; localStorage.setItem('aether_bg_' + S.chat.conversationId, k); }
    else { delete msgs.dataset.bg; localStorage.removeItem('aether_bg_' + S.chat.conversationId); }
    close();
    toast(`${icon('image', 14, 'accent')} Background updated.`);
  });
}

/* Forward a message to someone else in your universe. */
function showForward(m) {
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  const targets = S.people.filter(p => p.conversation_id !== S.chat?.conversationId);
  root.innerHTML = `
  <div class="palette-veil" id="fwd-veil">
    <div class="palette">
      <div style="padding:15px 18px;border-bottom:1px solid var(--line);display:flex;gap:9px;align-items:center">
        ${icon('forward', 17, 'accent')}<b>Forward to…</b>
        <span class="faint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${esc((m.body || m.attachment?.name || '').slice(0, 60))}”</span>
        <button class="btn ghost small" id="fwd-close">${icon('x', 12)}</button>
      </div>
      <div class="results">
        ${targets.map(p => `<button class="pal-row" data-fwd-to="${p.conversation_id}">${avatarHtml(p, 'sm')}<span class="s"><b>${esc(p.display_name)}</b> · ${esc(p.kind)}</span></button>`).join('')
          || '<div class="empty">No one else to forward to yet.</div>'}
      </div>
    </div>
  </div>`;
  $('#fwd-close').onclick = close;
  $('#fwd-veil').onmousedown = e => { if (e.target.id === 'fwd-veil') close(); };
  root.querySelectorAll('[data-fwd-to]').forEach(b => b.onclick = () => {
    S.socket.emit('message:send', {
      conversationId: Number(b.dataset.fwdTo),
      body: m.body || '', attachment: m.attachment || null, forwarded: true,
    }, r => {
      if (r?.ok) toast(`${icon('forward', 14, 'accent')} Forwarded.`);
      else toast(esc(r?.error || 'Could not forward'), true);
    });
    close();
  });
}

/* ============================================================================
   Voice & video calls — WebRTC, peer-to-peer. The server only relays the
   handshake; your voice and face never touch it. Includes screen share.
   ============================================================================ */
const CALL = { pc: null, stream: null, other: null, media: 'audio', t0: 0, timer: null };
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const sig = (to, data) => S.socket.emit('call:signal', { to, data });

function callUI(state, who) {
  let root = $('#call-root');
  if (!root) { root = document.createElement('div'); root.id = 'call-root'; document.body.appendChild(root); }
  if (state === 'closed') { root.innerHTML = ''; return; }
  root.innerHTML = `
  <div class="call-veil">
    <div class="call-card">
      <div class="call-vids ${CALL.media === 'audio' ? 'audio-only' : ''}">
        <video id="rv" autoplay playsinline></video>
        <video id="lv" autoplay playsinline muted></video>
        ${CALL.media === 'audio' ? `<div class="call-avatar">${avatarHtml(who || {}, 'xl')}</div>` : ''}
      </div>
      <div class="call-name">${esc(who?.display_name || '')} <span class="faint" id="call-state">${state}</span></div>
      <div class="call-acts">
        <button class="btn ghost round" id="c-mute" title="Mute">${icon('mic', 17)}</button>
        ${CALL.media === 'video' ? `<button class="btn ghost round" id="c-cam" title="Camera">${icon('video', 17)}</button>
        <button class="btn ghost round" id="c-screen" title="Share screen">${icon('screen', 17)}</button>` : ''}
        <button class="btn round" id="c-end" style="background:linear-gradient(135deg,#ff5c8a,#ff8a5c)" title="End">${icon('call', 17)}</button>
      </div>
    </div>
  </div>`;
  $('#c-end').onclick = () => endCall(true);
  $('#c-mute').onclick = e => {
    const t = CALL.stream?.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; e.currentTarget.innerHTML = icon(t.enabled ? 'mic' : 'micOff', 17); e.currentTarget.classList.toggle('on', !t.enabled); }
  };
  $('#c-cam') && ($('#c-cam').onclick = e => {
    const t = CALL.stream?.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; e.currentTarget.innerHTML = icon(t.enabled ? 'video' : 'videoOff', 17); e.currentTarget.classList.toggle('on', !t.enabled); }
  });
  $('#c-screen') && ($('#c-screen').onclick = async () => {
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = disp.getVideoTracks()[0];
      const sender = CALL.pc?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) { sender.replaceTrack(track); track.onended = () => sender.replaceTrack(CALL.stream.getVideoTracks()[0]); }
    } catch { /* user cancelled */ }
  });
}

async function makePc(otherId) {
  const pc = new RTCPeerConnection(RTC_CFG);
  pc.onicecandidate = e => { if (e.candidate) sig(otherId, { type: 'ice', candidate: e.candidate }); };
  pc.ontrack = e => { const rv = $('#rv'); if (rv && e.streams[0]) rv.srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    const el = $('#call-state');
    if (pc.connectionState === 'connected' && el) {
      CALL.t0 = Date.now();
      clearInterval(CALL.timer);
      CALL.timer = setInterval(() => {
        const s = Math.floor((Date.now() - CALL.t0) / 1000);
        const e2 = $('#call-state');
        if (e2) e2.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
    }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endCall(false);
  };
  return pc;
}

async function grabMedia(media) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
  } catch { toast('Mic/camera permission needed for calls.', true); return null; }
}

async function startCall(other, media) {
  if (CALL.pc) return toast('Already in a call.', true);
  const stream = await grabMedia(media);
  if (!stream) return;
  CALL.media = media; CALL.other = other.other_id; CALL.stream = stream;
  callUI('ringing…', other);
  const lv = $('#lv'); if (lv) lv.srcObject = stream;
  CALL.pc = await makePc(other.other_id);
  stream.getTracks().forEach(t => CALL.pc.addTrack(t, stream));
  const offer = await CALL.pc.createOffer();
  await CALL.pc.setLocalDescription(offer);
  sig(other.other_id, { type: 'offer', sdp: offer, media });
}

async function acceptCall(from, fromMeta, offer, media) {
  const stream = await grabMedia(media);
  if (!stream) { sig(from, { type: 'end' }); return; }
  CALL.media = media; CALL.other = from; CALL.stream = stream;
  callUI('connecting…', fromMeta);
  const lv = $('#lv'); if (lv) lv.srcObject = stream;
  CALL.pc = await makePc(from);
  stream.getTracks().forEach(t => CALL.pc.addTrack(t, stream));
  await CALL.pc.setRemoteDescription(offer);
  const answer = await CALL.pc.createAnswer();
  await CALL.pc.setLocalDescription(answer);
  sig(from, { type: 'answer', sdp: answer });
}

function endCall(tellPeer) {
  if (tellPeer && CALL.other) sig(CALL.other, { type: 'end' });
  clearInterval(CALL.timer);
  CALL.pc?.close();
  CALL.stream?.getTracks().forEach(t => t.stop());
  Object.assign(CALL, { pc: null, stream: null, other: null, t0: 0, timer: null });
  callUI('closed');
}

/* ============================================================================
   Music Sync — two people listen to the SAME uploaded clip in real time.
   The clip is a normal /upload audio file (100% free, no Spotify). Play/pause
   state is relayed over sockets; a shared <audio> stays in lockstep.
   ============================================================================ */
const MUSIC = { el: null, url: null };

function musicBar() {
  let bar = $('#music-bar');
  if (!bar) {
    const msgs = $('#msgs');
    if (!msgs) return null;
    msgs.insertAdjacentHTML('beforebegin', `<div id="music-bar" class="music-bar" hidden></div>`);
    bar = $('#music-bar');
  }
  return bar;
}

function showMusicBar(url, name, controllable) {
  const bar = musicBar();
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `
    ${icon('music', 16, 'accent')}
    <div style="flex:1;min-width:0"><b>Listening together</b><div class="faint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name || 'shared clip')}</div></div>
    <audio id="music-el" src="${esc(url)}" ${controllable ? 'controls' : ''} style="height:34px;max-width:200px"></audio>
    <button class="btn ghost small" id="music-x" title="Leave">${icon('x', 12)}</button>`;
  MUSIC.el = $('#music-el'); MUSIC.url = url;
  $('#music-x').onclick = () => stopMusicSync(true);
  if (controllable) {
    MUSIC.el.onplay = () => S.socket.emit('music:sync', { conversationId: S.chat.conversationId, action: 'play', url, t: MUSIC.el.currentTime, at: Date.now() });
    MUSIC.el.onpause = () => { if (!MUSIC.el.ended) S.socket.emit('music:sync', { conversationId: S.chat.conversationId, action: 'pause', url, t: MUSIC.el.currentTime, at: Date.now() }); };
  }
}

async function startMusicSync() {
  if (!S.chat?.other) return;
  // Pick an audio clip: reuse the file picker, restricted to audio.
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'audio/*';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('Keep the clip under 8 MB.', true);
    toast(`${icon('music', 14)} Sharing the vibe…`);
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      const up = await api('/upload', { body: { name: f.name, type: f.type, dataBase64: String(dataUrl).split(',')[1] } });
      showMusicBar(up.url, f.name, true);
      S.socket.emit('music:sync', { conversationId: S.chat.conversationId, action: 'start', url: up.url, t: 0, at: Date.now() });
    } catch (e) { toast(esc(e.message), true); }
  };
  input.click();
}

// When both sides are listening together, flash the aurora with the beat.
let _beatTimer = null;
function beatPulse() {
  const arena = document.querySelector('.mglow');
  if (!arena || !MUSIC.el) return;
  clearInterval(_beatTimer);
  _beatTimer = setInterval(() => {
    if (!MUSIC.el || MUSIC.el.paused) { clearInterval(_beatTimer); return; }
    arena.classList.add('beat');
    setTimeout(() => arena.classList.remove('beat'), 260);
  }, 500);
}

function stopMusicSync(tell) {
  if (tell && S.chat) S.socket.emit('music:sync', { conversationId: S.chat.conversationId, action: 'stop' });
  MUSIC.el?.pause();
  const bar = $('#music-bar');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
  MUSIC.el = null; MUSIC.url = null;
}

function wireMusicSync(socket) {
  socket.on('music:sync', ({ conversationId, fromName, action, url, at, t }) => {
    if (S.chat?.conversationId !== conversationId) return;
    if (action === 'stop') { stopMusicSync(false); return; }
    if (action === 'start') {
      showMusicBar(url, 'shared by ' + (fromName || 'them'), false);
      toast(`${icon('music', 14, 'accent')} ${esc(fromName || 'Someone')} started a listening session`);
      return;
    }
    if (!MUSIC.el || MUSIC.url !== url) showMusicBar(url, 'shared clip', false);
    // Compensate for relay latency so both sides land on the same second
    const lag = Math.max(0, (Date.now() - (at || Date.now())) / 1000);
    const target = (Number(t) || 0) + (action === 'play' ? lag : 0);
    if (MUSIC.el) {
      if (Math.abs(MUSIC.el.currentTime - target) > 0.4) MUSIC.el.currentTime = target;
      if (action === 'play') { MUSIC.el.play().catch(() => {}); beatPulse(); }
      else if (action === 'pause') MUSIC.el.pause();
    }
  });
}

function wireCallSignals(socket) {
  socket.on('call:signal', async ({ from, fromName, fromHue, fromAvatar, data }) => {
    const meta = { display_name: fromName, avatar_hue: fromHue, avatar_url: fromAvatar };
    if (data.type === 'offer') {
      if (CALL.pc) return sig(from, { type: 'end' }); // busy
      const root = document.createElement('div');
      root.className = 'call-veil'; root.id = 'ring-veil';
      root.innerHTML = `
        <div class="call-card ringing">
          ${avatarHtml(meta, 'xl')}
          <div class="call-name">${esc(fromName)}</div>
          <div class="muted">incoming ${data.media} call…</div>
          <div class="call-acts">
            <button class="btn round" id="ring-yes" style="background:linear-gradient(135deg,#34e3c2,#4ade80)">${icon(data.media === 'video' ? 'video' : 'call', 18)}</button>
            <button class="btn round" id="ring-no" style="background:linear-gradient(135deg,#ff5c8a,#ff8a5c)">${icon('x', 18)}</button>
          </div>
        </div>`;
      document.body.appendChild(root);
      $('#ring-yes').onclick = () => { root.remove(); acceptCall(from, meta, data.sdp, data.media); };
      $('#ring-no').onclick = () => { root.remove(); sig(from, { type: 'end' }); };
      setTimeout(() => { if ($('#ring-veil')) { root.remove(); sig(from, { type: 'end' }); } }, 45000);
    } else if (data.type === 'answer') {
      await CALL.pc?.setRemoteDescription(data.sdp);
    } else if (data.type === 'ice') {
      try { await CALL.pc?.addIceCandidate(data.candidate); } catch { /* late candidate */ }
    } else if (data.type === 'end') {
      $('#ring-veil')?.remove();
      if (CALL.pc) { toast(`${icon('call', 14)} Call ended.`); endCall(false); }
    }
  });
}

/* ============================================================================
   Group calls in Living Spaces (Phase 7) — mesh WebRTC, one peer connection
   per member. The newcomer initiates offers to everyone already in the room
   (no glare); the server only relays handshakes and counts heads.
   ============================================================================ */
const GCALL = { convoId: null, name: '', stream: null, media: 'audio', party: false, pcs: new Map(), metas: new Map(), streams: new Map() };
const gsig = (to, data) => S.socket.emit('call:room:signal', { conversationId: GCALL.convoId, to, data });
const PARTY_REACTS = ['love', 'hyped', 'joy', 'jk', 'flame', 'blown'];

function groupCallUI() {
  let root = $('#call-root');
  if (!root) { root = document.createElement('div'); root.id = 'call-root'; document.body.appendChild(root); }
  if (!GCALL.convoId) { root.innerHTML = ''; return; }
  const tiles = [...GCALL.metas.values()];
  const total = tiles.length + 1;
  root.innerHTML = `
  <div class="call-veil">
    <div class="call-card gcall ${GCALL.party ? 'party' : ''}">
      ${GCALL.party ? `<div class="party-head">${icon('flame', 18)} <b>Party Vibez</b> · ${esc(GCALL.name)}</div>` : ''}
      <div class="gcall-grid">
        <div class="gtile">${GCALL.media === 'audio' ? avatarHtml(S.me, 'lg') : ''}<video id="gv-local" autoplay playsinline muted ${GCALL.media === 'audio' ? 'style="display:none"' : ''}></video><span>you</span></div>
        ${tiles.map(p => `
        <div class="gtile">${GCALL.media === 'audio' ? avatarHtml({ display_name: p.name, avatar_hue: p.hue, avatar_url: p.avatar }, 'lg') : ''}
          <video id="gv-${p.userId}" autoplay playsinline ${GCALL.media === 'audio' ? 'style="height:0"' : ''}></video>
          <span>${esc((p.name || '?').split(' ')[0])}</span>
        </div>`).join('')}
      </div>
      <div class="call-name">${GCALL.party ? '' : esc(GCALL.name) + ' '}<span class="faint">${total} of ${GCALL.max || 5} in the room</span></div>
      ${GCALL.party ? `<div class="party-reacts">${PARTY_REACTS.map(k => `<button data-preact="${k}" title="${MOODS[k]?.label || k}">${mood(k, 26)}</button>`).join('')}</div>` : ''}
      <div class="call-acts">
        <button class="btn ghost round" id="gc-mute" title="Mute">${icon('mic', 17)}</button>
        ${GCALL.media === 'video' ? `<button class="btn ghost round" id="gc-cam" title="Camera">${icon('video', 17)}</button>` : ''}
        <button class="btn round" id="gc-end" style="background:linear-gradient(135deg,#ff5c8a,#ff8a5c)" title="Leave">${icon('call', 17)}</button>
      </div>
    </div>
    <div class="party-float" id="party-float"></div>
  </div>`;
  root.querySelectorAll('[data-preact]').forEach(b => b.onclick = () => {
    S.socket.emit('call:room:react', { conversationId: GCALL.convoId, kind: b.dataset.preact });
    floatReact(b.dataset.preact); // instant local feedback
  });
  const lv = $('#gv-local');
  if (lv && GCALL.stream) lv.srcObject = GCALL.stream;
  for (const [id, stream] of GCALL.streams) { const v = $(`#gv-${id}`); if (v) v.srcObject = stream; }
  $('#gc-end').onclick = () => leaveGroupCall();
  $('#gc-mute').onclick = e => {
    const t = GCALL.stream?.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; e.currentTarget.innerHTML = icon(t.enabled ? 'mic' : 'micOff', 17); e.currentTarget.classList.toggle('on', !t.enabled); }
  };
  $('#gc-cam') && ($('#gc-cam').onclick = e => {
    const t = GCALL.stream?.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; e.currentTarget.innerHTML = icon(t.enabled ? 'video' : 'videoOff', 17); e.currentTarget.classList.toggle('on', !t.enabled); }
  });
}

async function gPc(peerId) {
  const pc = new RTCPeerConnection(RTC_CFG);
  GCALL.pcs.set(peerId, pc);
  GCALL.stream.getTracks().forEach(t => pc.addTrack(t, GCALL.stream));
  pc.onicecandidate = e => { if (e.candidate) gsig(peerId, { type: 'ice', candidate: e.candidate }); };
  pc.ontrack = e => {
    if (!e.streams[0]) return;
    GCALL.streams.set(peerId, e.streams[0]);
    const v = $(`#gv-${peerId}`);
    if (v) v.srcObject = e.streams[0];
  };
  return pc;
}

async function joinGroupCall(conversationId, media, name, party = false) {
  if (CALL.pc || GCALL.convoId) return toast('Already in a call.', true);
  const stream = await grabMedia(media);
  if (!stream) return;
  Object.assign(GCALL, { convoId: conversationId, media, stream, name: name || 'Space call', party });
  S.socket.emit('call:room:join', { conversationId, media, party }, async ack => {
    if (!ack?.ok) { cleanupGroupCall(); return toast(esc(ack?.error || 'Could not join the call.'), true); }
    GCALL.party = ack.party; GCALL.max = ack.max || 5; // the room's existing vibe wins
    for (const p of ack.peers) GCALL.metas.set(p.userId, p);
    groupCallUI();
    for (const p of ack.peers) { // newcomer calls everyone already there
      const pc = await gPc(p.userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      gsig(p.userId, { type: 'offer', sdp: offer });
    }
  });
}

function cleanupGroupCall() {
  for (const pc of GCALL.pcs.values()) pc.close();
  GCALL.stream?.getTracks().forEach(t => t.stop());
  Object.assign(GCALL, { convoId: null, name: '', stream: null, party: false, pcs: new Map(), metas: new Map(), streams: new Map() });
  groupCallUI();
}

/* Party Vibez: a tapped mood blob floats up the screen and fades. */
function floatReact(kind) {
  const layer = $('#party-float');
  if (!layer) return;
  const b = document.createElement('div');
  b.className = 'float-blob';
  b.style.left = (12 + Math.random() * 76) + '%';
  b.innerHTML = mood(kind, 40);
  layer.appendChild(b);
  setTimeout(() => b.remove(), 2600);
}

function leaveGroupCall() {
  if (GCALL.convoId) S.socket.emit('call:room:leave', { conversationId: GCALL.convoId });
  cleanupGroupCall();
}

function wireGroupCallSignals(socket) {
  socket.on('call:room:peer-joined', ({ conversationId, userId, name, hue, avatar }) => {
    if (GCALL.convoId !== conversationId || userId === S.me.id) return;
    GCALL.metas.set(userId, { userId, name, hue, avatar });
    groupCallUI(); // their offer arrives next — the tile is already waiting
  });
  socket.on('call:room:signal', async ({ conversationId, from, name, hue, avatar, data }) => {
    if (GCALL.convoId !== conversationId) return;
    try {
      if (data.type === 'offer') {
        if (!GCALL.metas.has(from)) { GCALL.metas.set(from, { userId: from, name, hue, avatar }); groupCallUI(); }
        const pc = GCALL.pcs.get(from) || await gPc(from);
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        gsig(from, { type: 'answer', sdp: answer });
      } else if (data.type === 'answer') {
        await GCALL.pcs.get(from)?.setRemoteDescription(data.sdp);
      } else if (data.type === 'ice') {
        await GCALL.pcs.get(from)?.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch { /* a peer with a broken handshake shouldn't kill the room */ }
  });
  socket.on('call:room:peer-left', ({ conversationId, userId }) => {
    if (GCALL.convoId !== conversationId) return;
    GCALL.pcs.get(userId)?.close();
    GCALL.pcs.delete(userId); GCALL.metas.delete(userId); GCALL.streams.delete(userId);
    groupCallUI();
  });
  socket.on('call:room:react', ({ conversationId, kind }) => {
    if (GCALL.convoId === conversationId) floatReact(kind);
  });
}

/* "Catch me up" — AI summary of the conversation (local Ollama or honest heuristics). */
function mdLite(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
    .replace(/^[-•] (.*)$/gm, '<span style="display:block;padding-left:14px">• $1</span>')
    .replace(/^#{1,3} (.*)$/gm, '<b style="display:block;margin-top:8px">$1</b>')
    .replace(/\n/g, '<br>');
}

async function showSummary() {
  if (!S.chat) return;
  const conversationId = S.chat.conversationId;
  const root = $('#palette-root');
  root.innerHTML = `
  <div class="palette-veil" id="sum-veil">
    <div class="palette" style="padding:0">
      <div style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px">
        ${icon('sparkle', 19, 'accent')}<b>Catch me up</b>
        <button class="btn ghost small" style="margin-left:auto" id="sum-close">Esc</button>
      </div>
      <div style="padding:18px 20px;max-height:52vh;overflow-y:auto;font-size:14px" id="sum-body">
        <span class="muted">Reading the conversation…</span>
      </div>
      <div class="hint" id="sum-engine">running locally</div>
    </div>
  </div>`;
  const close = () => { root.innerHTML = ''; };
  $('#sum-close').onclick = close;
  $('#sum-veil').onmousedown = e => { if (e.target.id === 'sum-veil') close(); };
  try {
    const d = await api(`/conversations/${conversationId}/summary`);
    if (!$('#sum-body')) return;
    $('#sum-body').innerHTML = mdLite(d.text);
    $('#sum-engine').innerHTML = d.engine === 'heuristic'
      ? `${icon('search', 12)} local heuristics — install Ollama (ollama.com) and this becomes a real local AI, still fully private`
      : `${icon('cpu', 12)} ${esc(d.engine)} · ran entirely on this machine`;
  } catch (e) {
    if ($('#sum-body')) $('#sum-body').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

/* Relationship side panel: who they are TO YOU + shared timeline. */
async function renderSidePanel() {
  const { other } = S.chat;
  const panel = $('#side-panel');
  if (!panel || !other) return;
  const [prof, tl] = await Promise.all([
    api('/people/' + other.other_id + '/profile').catch(() => null),
    api('/people/' + other.other_id + '/timeline').catch(() => ({ events: [] })),
  ]);
  panel.innerHTML = `
    <div class="center">
      ${avatarHtml(other, 'lg')}
      <div style="font-weight:800;font-size:16px;margin-top:2px">${esc(other.display_name)}</div>
      ${prof?.persona ? `<div class="muted">${icon(prof.persona.emoji, 13)} shows you their <b>${esc(prof.persona.name)}</b> self</div>` : ''}
      ${prof?.persona?.bio ? `<div class="faint" style="margin-top:4px">${esc(prof.persona.bio)}</div>` : ''}
      <div style="display:flex;gap:6px;justify-content:center;margin-top:10px;flex-wrap:wrap">
        <button class="btn ghost small" id="wrapped-btn">${icon('sparkle', 13, 'accent')} Wrapped</button>
        <button class="btn ghost small" id="pin-btn" style="${other.pinned ? 'border-color:var(--accent);color:var(--accent)' : ''}">${icon('star4', 12)} ${other.pinned ? 'Pinned' : 'Pin'}</button>
        <button class="btn ghost small" id="mute-btn" style="${other.muted ? 'border-color:var(--accent);color:var(--accent)' : ''}">${icon('moon', 12)} ${other.muted ? 'Muted' : 'Mute'}</button>
      </div>
    </div>
    <div class="section-title">This relationship</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <select class="input" id="rel-kind">${S.relKinds.map(k => `<option ${k === other.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <select class="input" id="rel-close">
        <option value="1" ${other.closeness === 1 ? 'selected' : ''}>Inner circle — their words weigh more</option>
        <option value="2" ${other.closeness === 2 ? 'selected' : ''}>Regular orbit</option>
        <option value="3" ${other.closeness === 3 ? 'selected' : ''}>Outer orbit</option>
      </select>
      <select class="input" id="rel-persona">
        <option value="">They see: default me</option>
        ${S.personas.map(p => `<option value="${p.id}" ${other.persona_id === p.id ? 'selected' : ''}>They see: ${esc(p.name)}</option>`).join('')}
      </select>
    </div>
    <div class="section-title">Next time we talk…</div>
    <div class="add-inline" style="margin-bottom:4px">
      <input class="input" id="rem-new" placeholder="bring up the internship…" style="font-size:13px"/>
      <button class="btn small" id="rem-add">${icon('plus', 12)}</button>
    </div>
    <div class="faint" style="margin-bottom:4px">surfaces at the top of this chat until you bring it up</div>
    <div class="section-title">Shared files</div>
    <div id="sp-files" class="faint">Looking…</div>
    <div class="section-title">Shared timeline</div>
    <div id="tl">${tl.events.length ? tl.events.map(e => `
      <div class="tl-event"><span class="ico">${icon(TL_ICONS[e.type] || 'circleDot', 15, 'dim')}</span>
      <div><div class="t">${esc(e.title)}</div><div class="d">${new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div></div></div>`).join('')
      : '<div class="faint">Your story together starts now.</div>'}</div>`;

  api(`/conversations/${S.chat.conversationId}/files`).then(f => {
    const box = $('#sp-files');
    if (!box) return;
    box.classList.remove('faint');
    box.innerHTML = f.files.slice(0, 6).map(x => `
      <a class="att-file" style="margin:3px 0" href="${esc(x.attachment.url)}" target="_blank" rel="noopener" download="${esc(x.attachment.name)}">
        ${icon((x.attachment.type || '').startsWith('image/') ? 'image' : 'paperclip', 13)} ${esc(x.attachment.name.slice(0, 26))}
      </a>`).join('') || '<div class="faint">Nothing shared yet.</div>';
  }).catch(() => {});

  $('#wrapped-btn').onclick = showWrapped;
  const relToggle = async patch => {
    await api('/people/' + other.relationship_id, { method: 'PATCH', body: patch }).catch(e => toast(esc(e.message), true));
    await refreshPeople();
    const fresh = S.people.find(p => p.other_id === other.other_id);
    if (fresh && S.chat) { S.chat.other = fresh; renderChatHead(); renderSidePanel(); }
  };
  $('#pin-btn').onclick = () => relToggle({ pinned: !other.pinned });
  $('#mute-btn').onclick = () => relToggle({ muted: !other.muted });
  $('#rem-add').onclick = async () => {
    const body = $('#rem-new').value.trim();
    if (!body) return;
    await api(`/people/${other.other_id}/reminders`, { body: { body } }).catch(e => toast(esc(e.message), true));
    $('#rem-new').value = '';
    toast(`${icon('bulb', 14, 'accent')} Noted. It'll be waiting next time.`);
    renderReminderBar();
  };
  $('#rem-new').onkeydown = e => { if (e.key === 'Enter') $('#rem-add').click(); };
  const save = async () => {
    await api('/people/' + other.relationship_id, {
      method: 'PATCH',
      body: { kind: $('#rel-kind').value, closeness: Number($('#rel-close').value), personaId: $('#rel-persona').value ? Number($('#rel-persona').value) : null },
    }).catch(e => toast(esc(e.message), true));
    await refreshPeople();
    const fresh = S.people.find(p => p.other_id === other.other_id);
    if (fresh && S.chat) { S.chat.other = fresh; renderChatHead(); }
  };
  $('#rel-kind').onchange = save; $('#rel-close').onchange = save; $('#rel-persona').onchange = save;
}

// ------------------------------------------------------------ spaces view -----
// Study Rooms (Phase 11) get note & question tabs; every space gets Files (Phase 6).
const spaceTabs = space => space?.kind === 'moodsync'
  ? [['chat', 'message', 'Chat'], ['members', 'users', 'Members']] // temporary rooms travel light
  : space?.kind === 'study'
  ? [['chat', 'message', 'Chat'], ['note', 'note', 'Notes'], ['question', 'help', 'Questions'], ['task', 'checkCircle', 'Tasks'], ['idea', 'bulb', 'Ideas'], ['roast', 'flame', 'Roast'], ['files', 'paperclip', 'Files'], ['members', 'users', 'Members']]
  : [['chat', 'message', 'Chat'], ['idea', 'bulb', 'Ideas'], ['task', 'checkCircle', 'Tasks'], ['decision', 'check', 'Decisions'], ['milestone', 'mountain', 'Milestones'], ['roast', 'flame', 'Roast'], ['files', 'paperclip', 'Files'], ['members', 'users', 'Members']];

async function renderSpaces() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="spaces-page"><div class="empty">Loading…</div></div></div>`;
  const d = await api('/spaces').catch(() => ({ spaces: [] }));
  if (S.view.name !== 'spaces') return;
  const moodRooms = d.spaces.filter(s => s.kind === 'moodsync');
  const normal = d.spaces.filter(s => s.kind !== 'moodsync');
  $('#spaces-page').innerHTML = `
    <h2>Living Spaces</h2>
    <div class="sub">Not chat rooms — a chat, its ideas, its tasks and its decisions living together.</div>
    ${moodRooms.length ? `
    <div class="section-title" style="margin-top:4px">MoodSync rooms — same mood, same room, six hours</div>
    <div class="space-grid" style="margin-bottom:16px">
      ${moodRooms.map(s => `
        <div class="card space-card moodsync-card" data-space="${s.id}">
          <div class="em" style="display:flex;align-items:center;gap:8px">${icon(s.emoji, 26, 'accent')}${s.mood ? mood(s.mood, 30) : ''}</div>
          <h3>${esc(s.name)}</h3>
          <div class="muted">${esc(s.description || '')}</div>
          <div class="stats">
            <span class="chip">${icon('users', 12)} ${s.member_count}</span>
            <span class="chip important">${icon('timer', 12)} ${timeLeft(s.expires_at)} left</span>
          </div>
        </div>`).join('')}
    </div>` : ''}
    <div style="margin-bottom:16px"><button class="btn" id="new-space">${icon('plus', 14)} Create a space</button></div>
    <div class="space-grid" id="space-grid">
      ${normal.map(s => `
        <div class="card space-card" data-space="${s.id}">
          <div class="em">${icon(s.emoji, 30, 'accent')}</div>
          <h3>${esc(s.name)}</h3>
          <div class="muted">${esc(s.description || '')}</div>
          <div class="stats">
            <span class="chip">${icon('users', 12)} ${s.member_count}</span>
            <span class="chip interesting">${icon('bulb', 12)} ${s.ideas}</span>
            <span class="chip ${s.open_tasks ? 'important' : 'ok'}">${icon('checkCircle', 12)} ${s.open_tasks} open</span>
          </div>
        </div>`).join('') || `<div class="empty"><span class="big">${icon('rocket', 34, 'dim')}</span>No spaces yet. Create one for anything alive: a startup, a trip, a family.</div>`}
    </div>`;
  document.querySelectorAll('[data-space]').forEach(el => el.onclick = () => go('/space/' + el.dataset.space));
  $('#new-space').onclick = () => {
    $('#space-grid').insertAdjacentHTML('afterbegin', `
      <div class="card">
        ${pickerHtml('ns-pick', 'space', 'rocket')}
        <input class="input" id="ns-name" placeholder="Space name" style="margin:10px 0 9px" />
        <input class="input" id="ns-desc" placeholder="What is it for?" style="margin-bottom:9px" />
        <button class="btn" id="ns-create" style="width:100%">Create</button>
      </div>`);
    const getIcon = wirePicker('ns-pick', 'rocket');
    $('#ns-create').onclick = async () => {
      try {
        const s = await api('/spaces', { body: { name: $('#ns-name').value, emoji: getIcon(), description: $('#ns-desc').value } });
        go('/space/' + s.id);
      } catch (e) { toast(esc(e.message), true); }
    };
    $('#ns-name').focus();
  };
}

async function renderSpaceDetail(spaceId, tab = 'chat') {
  const d = await api('/spaces/' + spaceId).catch(() => null);
  if (!d) { go('/spaces'); return; }
  if (tab === 'chat') { openChat(d.conversation_id); return; }
  if (S.chat) { S.socket?.emit('conversation:leave', S.chat.conversationId); S.chat = null; }

  const items = d.items.filter(i => i.type === tab);

  main().innerHTML = `
  <div class="convo-main" style="flex:1;min-height:0;display:flex;flex-direction:column">
    <div class="convo-head">
      <button class="btn ghost small" id="back-btn">${icon('chevLeft', 16)}</button>
      ${icon(d.space.emoji, 26, 'accent')}
      <div class="who"><div class="nm">${esc(d.space.name)}</div><div class="st">${esc(d.space.description || '')}</div></div>
    </div>
    <div class="tabs">${spaceTabs(d.space).map(([k, ic, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${icon(ic, 14)} ${l}</button>`).join('')}</div>
    <div class="page" id="space-body"></div>
  </div>`;
  $('#back-btn').onclick = () => go('/spaces');
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => renderSpaceDetail(spaceId, b.dataset.tab));

  const body = $('#space-body');
  if (tab === 'members') {
    // Phase 6: roles are visible and the owner steers — admins help
    const myRole = d.members.find(m => m.id === S.me.id)?.role || 'member';
    const canManage = ['owner', 'admin'].includes(myRole);
    body.innerHTML = `
      <div class="page-narrow">
        ${canManage ? `<div class="add-inline"><input class="input" id="sm-username" placeholder="username to invite" style="max-width:240px" /><button class="btn small" id="sm-add">Invite</button></div>`
          : `<div class="faint" style="margin-bottom:10px">Only the owner and admins can invite people here.</div>`}
        ${d.members.map(m => `<div class="persona-row">${avatarHtml(m)}
          <div style="flex:1"><b>${esc(m.display_name)}</b><div class="faint">@${esc(m.username)} · <span class="chip" style="font-size:10px;padding:0 7px">${esc(m.role)}</span></div></div>
          ${myRole === 'owner' && m.role !== 'owner' ? `<button class="btn ghost small" data-role="${m.id}" data-to="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Demote' : 'Make admin'}</button>` : ''}
          ${m.id === S.me.id && m.role !== 'owner' ? `<button class="btn ghost small" data-kick="${m.id}">Leave</button>`
            : (myRole === 'owner' && m.role !== 'owner') || (myRole === 'admin' && m.role === 'member') ? `<button class="btn ghost small" data-kick="${m.id}">${icon('x', 11)} Remove</button>` : ''}
        </div>`).join('')}
      </div>`;
    const smAdd = $('#sm-add');
    if (smAdd) smAdd.onclick = async () => {
      try { await api(`/spaces/${spaceId}/members`, { body: { username: $('#sm-username').value } }); toast(`${icon('users', 14, 'accent')} Invited.`); renderSpaceDetail(spaceId, 'members'); }
      catch (e) { toast(esc(e.message), true); }
    };
    body.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => {
      try { await api(`/spaces/${spaceId}/members/${b.dataset.role}`, { method: 'PATCH', body: { role: b.dataset.to } }); renderSpaceDetail(spaceId, 'members'); }
      catch (e) { toast(esc(e.message), true); }
    });
    body.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
      try {
        const leaving = Number(b.dataset.kick) === S.me.id;
        await api(`/spaces/${spaceId}/members/${b.dataset.kick}`, { method: 'DELETE' });
        if (leaving) return go('/spaces');
        renderSpaceDetail(spaceId, 'members');
      } catch (e) { toast(esc(e.message), true); }
    });
    return;
  }

  if (tab === 'roast') {
    // Roast My Life: volunteer yourself, get flamed anonymously, press Save Me
    const rd = await api(`/spaces/${spaceId}/roasts`).catch(() => ({ roasts: [] }));
    body.innerHTML = `
      <div class="page-narrow">
        <div class="card" style="margin-bottom:14px">
          <div class="section-title" style="margin-top:0">${icon('flame', 15, 'accent')} Roast My Life — post it, take the heat, press Save Me when you break</div>
          <textarea class="input" id="ro-text" rows="2" placeholder="drop a story or an L you took this week…"></textarea>
          <div style="display:flex;gap:8px;margin-top:9px;align-items:center">
            <input type="file" id="ro-file" accept="image/*" hidden />
            <button class="btn ghost small" id="ro-img">${icon('camera', 14)} <span id="ro-img-name">add a photo</span></button>
            <span class="faint" style="flex:1">replies are anonymous. choose violence responsibly.</span>
            <button class="btn small" id="ro-post">${icon('flame', 13)} Roast me</button>
          </div>
        </div>
        ${rd.roasts.map(r => `
        <button class="roast-row ${r.status}" data-roast="${r.id}">
          ${avatarHtml(r.roastee)}
          <div class="info">
            <div class="t"><b>${esc(r.roastee.display_name)}</b>
              ${r.status === 'live' ? `<span class="chip critical">${icon('flame', 11)} live</span>` : `<span class="chip ok">${icon('shield', 11)} saved</span>`}
            </div>
            <div class="m">${esc((r.body || 'a photo, no caption, pure confidence').slice(0, 90))}</div>
            <div class="faint">${r.replies} roast${r.replies === 1 ? '' : 's'} · ${timeAgo(r.created_at)} ago</div>
          </div>
          ${r.attachment ? `<img class="roast-thumb" src="${esc(r.attachment.url)}" alt="">` : ''}
        </button>`).join('') || `<div class="empty"><span class="big">${icon('flame', 32, 'dim')}</span>Nobody has volunteered yet. Be the main course.</div>`}
      </div>`;
    let roMedia = null;
    $('#ro-img').onclick = () => $('#ro-file').click();
    $('#ro-file').onchange = async () => {
      const f = $('#ro-file').files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast('Max 8 MB.', true);
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      roMedia = await api('/upload', { body: { name: f.name, type: f.type, dataBase64: String(dataUrl).split(',')[1] } }).catch(e => (toast(esc(e.message), true), null));
      if (roMedia) $('#ro-img-name').textContent = f.name.slice(0, 18);
    };
    $('#ro-post').onclick = async () => {
      const text = $('#ro-text').value.trim();
      if (!text && !roMedia) return toast('Give them SOMETHING to work with.', true);
      try {
        const r = await api(`/spaces/${spaceId}/roasts`, { body: { body: text, attachment: roMedia } });
        toast(`${icon('flame', 14, 'accent')} You're on the grill. Godspeed.`);
        showRoast(r.id, spaceId);
      } catch (e) { toast(esc(e.message), true); }
    };
    body.querySelectorAll('[data-roast]').forEach(b => b.onclick = () => showRoast(Number(b.dataset.roast), spaceId));
    return;
  }

  if (tab === 'files') {
    // Phase 6: everything ever shared in this space, one wall
    const f = await api(`/conversations/${d.conversation_id}/files`).catch(() => ({ files: [] }));
    body.innerHTML = `
      <div class="page-narrow">
        ${f.files.map(x => `
        <div class="item-row">
          <span class="tick">${icon((x.attachment.type || '').startsWith('image/') ? 'image' : (x.attachment.type || '').startsWith('audio/') ? 'mic' : (x.attachment.type || '').startsWith('video/') ? 'video' : 'paperclip', 18, 'dim')}</span>
          <div class="body">
            ${(x.attachment.type || '').startsWith('image/') ? `<a href="${esc(x.attachment.url)}" target="_blank" rel="noopener"><img class="att-img" style="max-height:110px" src="${esc(x.attachment.url)}" alt=""></a>` : ''}
            <div class="t"><a href="${esc(x.attachment.url)}" target="_blank" rel="noopener" download="${esc(x.attachment.name)}">${esc(x.attachment.name)}</a></div>
            <div class="by">${esc(x.sender_name)} · ${timeAgo(x.created_at)} ago · ${fmtSize(x.attachment.size || 0)}</div>
          </div>
        </div>`).join('') || `<div class="empty"><span class="big">${icon('paperclip', 30, 'dim')}</span>Nothing shared yet.</div>`}
      </div>`;
    return;
  }

  const NAMES = {
    idea: ['bulb', 'idea', 'What if…'], task: ['checkCircle', 'task', 'What needs doing?'],
    decision: ['check', 'decision', 'What did we decide?'], milestone: ['mountain', 'milestone', 'What happened?'],
    note: ['note', 'note', 'Write it down before it evaporates…'], question: ['help', 'question', 'What are we stuck on?'],
  };
  const [emo, label, ph] = NAMES[tab];
  body.innerHTML = `
    <div class="page-narrow">
      <div class="add-inline">
        <input class="input" id="si-title" placeholder="${ph}" />
        <button class="btn small" id="si-add">${icon('plus', 13)} ${label}</button>
      </div>
      <div id="si-list">
        ${items.map(i => `
        <div class="item-row ${i.status === 'done' ? 'done' : ''}">
          ${['task', 'question'].includes(tab) ? `<button class="tick" title="${tab === 'question' ? 'answered?' : 'done?'}" data-toggle="${i.id}" data-status="${i.status}">${icon(i.status === 'done' ? 'checkCircle' : 'circleDot', 19, i.status === 'done' ? 'ok' : 'dim')}</button>` : `<span class="tick">${icon(emo, 18, 'dim')}</span>`}
          <div class="body">
            <div class="t">${esc(i.title)}</div>
            ${i.body ? `<div class="b">${esc(i.body)}</div>` : ''}
            <div class="by">${esc(i.creator_name)} · ${timeAgo(i.created_at)} ago</div>
          </div>
        </div>`).join('') || `<div class="empty"><span class="big">${icon(emo, 32, 'dim')}</span>No ${label}s yet.</div>`}
      </div>
    </div>`;
  $('#si-add').onclick = async () => {
    const title = $('#si-title').value.trim();
    if (!title) return;
    try { await api(`/spaces/${spaceId}/items`, { body: { type: tab, title } }); renderSpaceDetail(spaceId, tab); }
    catch (e) { toast(esc(e.message), true); }
  };
  $('#si-title').onkeydown = e => { if (e.key === 'Enter') $('#si-add').click(); };
  body.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    await api(`/spaces/${spaceId}/items/${b.dataset.toggle}`, { method: 'PATCH', body: { status: b.dataset.status === 'done' ? 'open' : 'done' } });
    renderSpaceDetail(spaceId, tab);
  });
}

/* ---- Roast My Life: the grill, full screen ---------------------------------- */
async function showRoast(roastId, spaceId) {
  const root = $('#palette-root');
  let timer = null;
  const close = () => { clearInterval(timer); root.innerHTML = ''; if (S.view?.name === 'space') renderSpaceDetail(spaceId, 'roast'); };
  const draw = async (focusReply = false) => {
    const d = await api('/roasts/' + roastId).catch(() => null);
    if (!d) { close(); return; }
    const { roast, replies } = d;
    const live = roast.status === 'live';
    const draft = $('#ro-reply')?.value || '';
    root.innerHTML = `
    <div class="palette-veil" id="rv-veil"><div class="palette roast-view" style="padding:18px 20px">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
        ${avatarHtml(roast.roastee)}
        <div style="flex:1"><b>${esc(roast.roastee.display_name)}</b> <span class="faint">is getting roasted</span></div>
        ${live ? `<span class="chip critical">${icon('flame', 11)} live</span>` : `<span class="chip ok">${icon('shield', 11)} saved</span>`}
        <button class="btn ghost small" id="rv-close">${icon('x', 12)}</button>
      </div>
      ${roast.attachment ? `<img class="roast-hero" src="${esc(roast.attachment.url)}" alt="">` : ''}
      ${roast.body ? `<p style="margin:8px 0 4px">${richBody(roast.body)}</p>` : ''}
      <div class="section-title">the roasts · anonymous, allegedly</div>
      <div class="roast-replies" id="rv-list">
        ${replies.map(r => `<div class="roast-reply ${r.mine ? 'mine' : ''}">
          <b>${esc(r.alias)}${r.mine ? ' (you)' : ''}</b>
          <div>${richBody(r.body)}</div>
          <span class="faint">${timeAgo(r.created_at)} ago</span>
        </div>`).join('') || `<div class="empty" style="padding:18px 0">Crickets. ${live ? 'The grill is hot and nobody is cooking.' : ''}</div>`}
      </div>
      ${live ? `
      <div style="display:flex;gap:8px;margin-top:10px">
        <input class="input" id="ro-reply" placeholder="cook. it's anonymous…" style="flex:1" />
        <button class="btn small" id="rv-send">${icon('flame', 13)}</button>
        ${roast.mine ? `<button class="btn small danger" id="rv-save" title="End the roast. Mercy is a button.">${icon('shield', 13)} Save Me</button>` : ''}
      </div>` : `<div class="faint" style="margin-top:10px">${roast.mine ? 'You saved yourself. Self-care.' : 'The roastee tapped out. Respect it.'}</div>`}
    </div></div>`;
    $('#rv-close').onclick = close;
    $('#rv-veil').onmousedown = e => { if (e.target.id === 'rv-veil') close(); };
    const list = $('#rv-list'); if (list) list.scrollTop = list.scrollHeight;
    const input = $('#ro-reply');
    if (input) {
      input.value = draft;
      if (focusReply) input.focus();
      const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        try { await api(`/roasts/${roastId}/replies`, { body: { body: text } }); draw(true); }
        catch (e) { toast(esc(e.message), true); }
      };
      input.onkeydown = e => { if (e.key === 'Enter') send(); };
      $('#rv-send').onclick = send;
    }
    const saveBtn = $('#rv-save');
    if (saveBtn) saveBtn.onclick = async () => {
      await api(`/roasts/${roastId}/save`, { body: {} }).catch(e => toast(esc(e.message), true));
      toast(`${icon('shield', 14, 'ok')} You saved yourself. The haters have been silenced.`);
      draw();
    };
  };
  await draw();
  timer = setInterval(() => {
    if (!$('#rv-veil')) return clearInterval(timer);
    if (document.activeElement?.id === 'ro-reply' && document.activeElement.value) return; // don't eat a mid-type roast
    draw(document.activeElement?.id === 'ro-reply');
  }, 5000);
}

// ------------------------------------------------------------ memory view -----
async function renderMemory() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="mem-page"><div class="empty">Loading…</div></div></div>`;
  const d = await api('/memories').catch(() => ({ memories: [] }));
  if (S.view.name !== 'memory') return;
  $('#mem-page').innerHTML = `
    <h2>Memory</h2>
    <div class="sub">Everything you asked Ikvizz to remember — forever, locally, yours.</div>
    <div class="add-inline">
      <input class="input" id="mem-new" placeholder="Remember this forever…" />
      <button class="btn small" id="mem-add">${icon('star', 13)} Remember</button>
    </div>
    <div id="mem-list">
      ${d.memories.map(m => `
      <div class="memory-row">
        <span class="ico">${icon('star', 17, 'accent')}</span>
        <div class="b">${esc(m.body)}
          ${m.note ? `<div class="n">${esc(m.note)}</div>` : ''}
          <div class="d">${new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <button class="btn ghost small" data-forget="${m.id}">Forget</button>
      </div>`).join('') || `<div class="empty"><span class="big">${icon('db', 32, 'dim')}</span>Hover any message and hit Remember — it lands here.</div>`}
    </div>`;
  $('#mem-add').onclick = async () => {
    const body = $('#mem-new').value.trim();
    if (!body) return;
    await api('/memories', { body: { body } }).catch(e => toast(esc(e.message), true));
    renderMemory();
  };
  $('#mem-new').onkeydown = e => { if (e.key === 'Enter') $('#mem-add').click(); };
  document.querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => {
    await api('/memories/' + b.dataset.forget, { method: 'DELETE' });
    renderMemory();
  });
}

// ---------------------------------------------------------------- me view -----
function renderMe() {
  const scope = S.me.context_scope;
  main().innerHTML = `
  <div class="page"><div class="page-narrow">
    <h2>You</h2>
    <div class="sub">Your contexts, your identities, your rules.</div>

    <div class="card" style="margin-bottom:14px">
      <div class="section-title" style="margin-top:0">Mood canvas — how you're feeling, as one of ours</div>
      <div class="mood-grid">
        ${MOOD_KINDS.map(k => `<button class="mood-opt ${S.me.mood === k ? 'active' : ''}" data-mymood="${k}" title="${MOODS[k].label}">${mood(k, 38)}<small>${MOODS[k].label}</small></button>`).join('')}
        <button class="mood-opt ${!S.me.mood ? 'active' : ''}" data-mymood="" title="no mood"><span style="font-size:24px;line-height:38px;color:var(--text-faint)">—</span><small>none</small></button>
      </div>
      <div class="faint" style="margin-top:8px">shown next to your name everywhere — expression, not surveillance</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="section-title" style="margin-top:0">Your card — how people find you</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button id="avatar-upload" title="Change profile photo" style="border-radius:50%">${avatarHtml(S.me, 'lg')}</button>
        <input type="file" id="avatar-file" accept="image/*" hidden />
        <div style="flex:1;min-width:160px">
          <b style="font-size:16px">@${esc(S.me.username)}</b>
          ${(S.me.rizz_king_until || 0) > Date.now() ? `<span class="chip rizz-king" title="Won a Rizz Battle — reign ends in ${timeLeft(S.me.rizz_king_until)}">${icon('crown', 11)} rizz king</span>` : ''}
          <div class="muted">${S.me.phone ? esc(S.me.phone) + ' · findable by phone' : 'no phone linked — findable by username only'}</div>
          <div class="faint">tap the photo to change it${S.me.avatar_url ? ' · <a href="#" id="avatar-clear">remove photo</a>' : ''}${S.me.avatar_config ? ' · <a href="#" id="avatar-clear-made">clear avatar</a>' : ''}</div>
        </div>
        <button class="btn small" id="make-avatar">${icon('smile', 13)} Create avatar</button>
        <button class="btn small" id="copy-invite">${icon('link', 13)} Copy invite link</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="section-title" style="margin-top:0">Live context — say it once, never explain</div>
      <div class="ctx-grid">
        ${S.contexts.map(c => `<button class="ctx-opt ${S.me.context === c.key ? 'active' : ''}" data-ctx="${c.key}"><span class="em">${icon(CTX_META[c.key]?.[0] || 'circleDot', 22)}</span>${c.label}</button>`).join('')}
      </div>
      <input class="input" id="ctx-note" placeholder="Optional note (e.g. 'back at 5pm')" value="${esc(S.me.context_note || '')}" style="margin-top:10px" />
      <div class="section-title">Who can see it</div>
      <div class="scope-row">
        ${[['all', 'orbit', 'Everyone'], ['inner', 'users', 'Inner circle only'], ['none', 'lock', 'No one']].map(([k, ic, l]) =>
          `<button class="btn ghost small" data-scope="${k}" style="${scope === k ? 'border-color:var(--accent);color:var(--accent)' : ''}">${icon(ic, 13)} ${l}</button>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="section-title" style="margin-top:0">Dynamic Identity — every relationship sees a different you</div>
      <div id="persona-list">
        ${S.personas.map(p => `<div class="persona-row"><span class="em">${icon(p.emoji, 21, 'accent')}</span><div style="flex:1"><b>${esc(p.name)}</b>${p.bio ? `<div class="faint">${esc(p.bio)}</div>` : ''}</div></div>`).join('')}
      </div>
      <div style="margin-top:12px">${pickerHtml('pe-pick', 'persona', 'smile')}</div>
      <div class="add-inline" style="margin-top:10px;margin-bottom:0">
        <input class="input" id="pe-name" placeholder="New persona (e.g. Gaming, Study)" />
        <button class="btn small" id="pe-add">${icon('plus', 13)} Add</button>
      </div>
      <div class="faint" style="margin-top:8px">Assign a persona per relationship from any chat's side panel.</div>
    </div>

    <div class="card install-card" id="install-card">
      <div class="ic-mark">${icon('download', 22, 'accent')}</div>
      <div style="flex:1;min-width:0">
        <b>Get the app</b>
        <div class="faint">Install Ikvizz on your phone, tablet or laptop — full-screen, launches from your home screen, works like a native app. No app store, no cost.</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn ghost" id="qr-btn" title="Show a QR code to open on a phone">${icon('share', 14)} QR</button>
        <button class="btn" id="install-btn">${icon('download', 14)} Install</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0">Appearance & account</div>
      ${document.documentElement.dataset.skin === 'pearl' ? `
      <div class="section-title" style="margin-top:0">Accent</div>
      <div class="faint" style="margin-bottom:14px">${icon('sparkle', 12, 'accent')} Ikvizz Luxe uses its signature champagne palette. Switch skin below to customise the accent.</div>` : `
      <div class="section-title" style="margin-top:0">Accent — make it yours</div>
      <div style="display:flex;gap:7px;margin-bottom:14px">
        ${[['violet', '#7b8cff'], ['teal', '#2dd4bf'], ['pink', '#f472b6'], ['amber', '#fbbf24']].map(([k, c]) =>
          `<button class="accent-dot ${(localStorage.getItem('aether_accent') || 'violet') === k ? 'sel' : ''}" data-accent-pick="${k}" style="background:${c}" title="${k}" aria-label="${k} accent"></button>`).join('')}
      </div>`}
      <div class="section-title" style="margin-top:0">Skin — pick your world</div>
      <div class="skin-pick" style="margin-bottom:14px">
        ${[['pearl', 'Ikvizz Luxe', 'champagne pearl · dark'], ['cozy', 'Digital Cozy', 'warm clay · cream'], ['off', 'Classic', 'deep space · neon']].map(([k, name, sub]) => {
          const cur = document.documentElement.dataset.skin || 'pearl';
          return `<button class="skin-opt ${cur === k ? 'sel' : ''}" data-skin-pick="${k}"><span class="sw sw-${k}"></span><span class="txt"><b>${name}</b><small>${sub}</small></span></button>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn ghost small" id="theme-btn">${icon('theme', 14)} Toggle theme</button>
        <button class="btn ghost small" id="export-btn">${icon('db', 14)} Export my universe</button>
        <button class="btn ghost small danger" id="signout-btn" style="background:transparent;border-color:var(--critical);color:var(--critical)">${icon('logout', 14)} Sign out</button>
      </div>
      <div class="faint" style="margin-top:10px">Signed in as @${esc(S.me.username)} · all data lives in one local SQLite file you own — export downloads it all as JSON, any time, no questions.</div>
    </div>
  </div></div>`;

  const setCtx = async (patch) => {
    const d = await api('/me/context', { method: 'PATCH', body: patch }).catch(e => (toast(esc(e.message), true), null));
    if (!d) return;
    S.me = d.user;
    S.socket.emit('context:set', { context: S.me.context, note: S.me.context_note, scope: S.me.context_scope });
    updateBadges(); renderMe();
  };
  document.querySelectorAll('[data-mymood]').forEach(b => b.onclick = async () => {
    const d = await api('/me/mood', { method: 'PATCH', body: { mood: b.dataset.mymood || null } }).catch(e => (toast(esc(e.message), true), null));
    if (d) {
      S.me = { ...S.me, mood: d.user.mood };
      // MoodSync Rooms: matching mood blobs get grouped into a temporary space
      if (d.moodsync) toast(`${icon('orbit', 14, 'accent')} Synced into <b>${esc(d.moodsync.name)}</b> — find it in Spaces. 6 hours, then it's a memory.`);
      renderMe();
    }
  });
  $('#copy-invite').onclick = async () => {
    const link = `${location.origin}/#/add/${S.me.username}`;
    try { await navigator.clipboard.writeText(link); toast(`${icon('link', 14, 'accent')} Invite link copied. Send it anywhere.`); }
    catch { toast(esc(link)); }
  };
  $('#avatar-upload').onclick = () => $('#avatar-file').click();
  $('#avatar-file').onchange = async () => {
    const file = $('#avatar-file').files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Photos only.', true);
    if (file.size > 4 * 1024 * 1024) return toast('Max 4 MB for a profile photo.', true);
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const up = await api('/upload', { body: { name: file.name, type: file.type, dataBase64: String(dataUrl).split(',')[1] } });
      const d = await api('/me', { method: 'PATCH', body: { avatarUrl: up.url } });
      S.me = { ...S.me, avatar_url: d.user.avatar_url };
      toast(`${icon('check', 14, 'ok')} Looking sharp.`);
      renderShell(); renderMe();
    } catch (e) { toast(esc(e.message), true); }
  };
  const clearBtn = $('#avatar-clear');
  if (clearBtn) clearBtn.onclick = async e => {
    e.preventDefault();
    const d = await api('/me', { method: 'PATCH', body: { avatarUrl: '' } });
    S.me = { ...S.me, avatar_url: d.user.avatar_url };
    renderShell(); renderMe();
  };
  $('#make-avatar').onclick = () => openAvatarCreator();
  const clearMade = $('#avatar-clear-made');
  if (clearMade) clearMade.onclick = async e => {
    e.preventDefault();
    await api('/me/avatar', { method: 'PATCH', body: { config: null } }).catch(() => {});
    S.me = { ...S.me, avatar_config: null };
    renderShell(); renderMe();
  };
  $('#export-btn').onclick = async () => {
    try {
      const data = await api('/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aether-universe.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`${icon('db', 14, 'accent')} Your universe, downloaded. It was always yours.`);
    } catch (e) { toast(esc(e.message), true); }
  };
  document.querySelectorAll('[data-ctx]').forEach(b => b.onclick = () => setCtx({ context: b.dataset.ctx, note: $('#ctx-note').value }));
  document.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => setCtx({ scope: b.dataset.scope }));
  $('#ctx-note').onchange = () => setCtx({ note: $('#ctx-note').value });
  const getPersonaIcon = wirePicker('pe-pick', 'smile');
  $('#pe-add').onclick = async () => {
    const name = $('#pe-name').value.trim();
    if (!name) return;
    const p = await api('/personas', { body: { name, emoji: getPersonaIcon() } }).catch(e => (toast(esc(e.message), true), null));
    if (p) { S.personas.push(p); renderMe(); }
  };
  document.querySelectorAll('[data-accent-pick]').forEach(b => b.onclick = () => {
    localStorage.setItem('aether_accent', b.dataset.accentPick);
    document.documentElement.dataset.accent = b.dataset.accentPick;
    renderMe();
  });
  $('#theme-btn').onclick = () => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    localStorage.setItem('aether_theme', cur);
  };
  document.querySelectorAll('[data-skin-pick]').forEach(b => b.onclick = () => {
    const next = b.dataset.skinPick;
    document.documentElement.dataset.skin = next;
    localStorage.setItem('aether_skin', next);
    renderMe();
  });
  $('#signout-btn').onclick = signOut;

  // Install (PWA): reflect installed state, otherwise prompt or guide.
  const installCard = $('#install-card');
  const isStandalone = matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (installCard && isStandalone) {
    installCard.innerHTML = `<div class="ic-mark">${icon('check', 22, 'ok')}</div>
      <div style="flex:1;min-width:0"><b>Installed</b><div class="faint">Ikvizz is on your home screen — you're using the full-screen app right now.</div></div>`;
  } else {
    $('#install-btn')?.addEventListener('click', promptInstall);
  }
  $('#qr-btn')?.addEventListener('click', showInstallQR);
}

/** A scannable QR of this site's URL — scan it on a phone to open (then install). */
function showInstallQR() {
  const url = location.origin + '/';
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) || location.hostname.endsWith('.local');
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data=${encodeURIComponent(url)}`;
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="qr-veil"><div class="palette" style="padding:22px;max-width:340px;text-align:center">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:14px;text-align:left">
      <span class="ic-mark">${icon('share', 18, 'accent')}</span><b style="font-size:16px">Scan to open Ikvizz</b>
      <button class="btn ghost small" id="qr-x" style="margin-left:auto" aria-label="Close">${icon('x', 12)}</button>
    </div>
    <div class="qr-frame"><img src="${esc(qr)}" alt="QR code for ${esc(url)}" width="220" height="220"
      onerror="this.parentNode.innerHTML='<div class=\\'faint\\' style=\\'padding:24px\\'>Couldn\\'t load the QR image — use the link below.</div>'"></div>
    <div class="qr-url">${esc(url)}</div>
    <button class="btn ghost small" id="qr-copy" style="margin-top:10px">${icon('copy', 13)} Copy link</button>
    ${isLocal ? `<div class="faint" style="margin-top:12px">This is your local address — only works on this computer. After you deploy (Render), reopen this and the QR will point to your public URL that anyone can scan.</div>` : `<div class="faint" style="margin-top:12px">Point a phone camera at this to open Ikvizz, then use <b>Install</b> / Add to Home Screen.</div>`}
  </div></div>`;
  $('#qr-x').onclick = close;
  $('#qr-veil').onmousedown = e => { if (e.target.id === 'qr-veil') close(); };
  $('#qr-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast(`${icon('check', 14, 'ok')} Link copied.`); }
    catch { toast('Copy failed — long-press the link to copy.', true); }
  };
}

/** Trigger the native install prompt, or show manual steps where it's unavailable (iOS). */
async function promptInstall() {
  const bip = window.__bip;
  if (bip) {
    bip.prompt();
    const choice = await bip.userChoice.catch(() => null);
    window.__bip = null;
    if (choice?.outcome === 'accepted') toast(`${icon('check', 14, 'ok')} Adding Ikvizz to your home screen…`);
    else showInstallHelp();
    return;
  }
  showInstallHelp();
}

/** Platform-aware "add to home screen" instructions for browsers without a prompt. */
function showInstallHelp() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const steps = isIOS
    ? [`Tap the <b>Share</b> button ${icon('share', 13)} in Safari's toolbar`, 'Scroll down and tap <b>Add to Home Screen</b>', 'Tap <b>Add</b> — Ikvizz lands on your home screen']
    : isAndroid
      ? ['Open the browser menu <b>⋮</b> (top-right)', 'Tap <b>Install app</b> / <b>Add to Home screen</b>', 'Confirm — Ikvizz installs like a native app']
      : ['Click the <b>install</b> icon in your browser\'s address bar', 'Or open the browser menu and choose <b>Install Ikvizz</b>', 'It opens in its own window, like a desktop app'];
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = `
  <div class="palette-veil" id="inst-veil"><div class="palette" style="padding:20px 22px;max-width:400px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <span class="ic-mark">${icon('download', 18, 'accent')}</span><b style="font-size:16px">Install Ikvizz</b>
      <button class="btn ghost small" id="inst-x" style="margin-left:auto" aria-label="Close">${icon('x', 12)}</button>
    </div>
    <div class="faint" style="margin-bottom:14px">${isIOS ? 'On iPhone & iPad' : isAndroid ? 'On Android' : 'On your computer'} — add it in three quick steps:</div>
    <ol class="inst-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
  </div></div>`;
  $('#inst-x').onclick = close;
  $('#inst-veil').onmousedown = e => { if (e.target.id === 'inst-veil') close(); };
}

// ============================================================================
// Ikvizz EDU — the Knowledge Universe. Concepts are planets: mastery is
// brightness, neglect makes them dim, prerequisites orbit as connections.
// ============================================================================
async function renderEdu() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="edu-page"><div class="empty">Mapping your universe…</div></div></div>`;
  const [d, dna, asg, rooms, cards] = await Promise.all([
    api('/edu/universe').catch(() => null),
    api('/edu/dna').catch(() => null),
    api('/edu/assignments').catch(() => ({ assignments: [] })),
    api('/edu/rooms').catch(() => ({ rooms: [] })),
    api('/edu/flashcards').catch(() => ({ cards: [] })),
  ]);
  if (!d || S.view.name !== 'edu') return;

  // Golden-angle spiral layout — stable, no physics needed
  const W = 900, H = 500, cx = W / 2, cy = H / 2;
  const pos = new Map();
  d.concepts.forEach((c, i) => {
    const a = i * 2.399963, r = i === 0 ? 0 : 52 + 44 * Math.sqrt(i);
    pos.set(c.id, { x: cx + r * Math.cos(a) * 1.3, y: cy + r * Math.sin(a) * 0.82 });
  });

  const planet = c => {
    const p = pos.get(c.id);
    const eff = c.effective;
    const R = 15 + eff * 0.17;
    const glow = eff / 100;
    return `
    <g class="planet ${S.eduSel === c.id ? 'sel' : ''}" data-cid="${c.id}" transform="translate(${p.x},${p.y})">
      <circle r="${R + 8}" fill="hsl(174,70%,55%)" opacity="${0.06 + glow * 0.22}"/>
      <circle r="${R}" fill="hsl(174,${25 + glow * 45}%,${20 + glow * 32}%)" stroke="hsl(174,60%,${30 + glow * 30}%)" stroke-width="1.5"/>
      <g style="color:hsl(174,50%,${55 + glow * 30}%)">${iconInSvg(c.emoji, R * 1.05)}</g>
      <text class="p-name" y="${R + 15}" text-anchor="middle">${esc(c.name)}</text>
      <text class="p-eff" y="${R + 28}" text-anchor="middle">${eff}%</text>
    </g>`;
  };
  const linkLine = l => {
    const a = pos.get(l.from_id), b = pos.get(l.to_id);
    return a && b ? `<line class="edu-link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>` : '';
  };

  const sel = d.concepts.find(c => c.id === S.eduSel);
  const prereqsOfSel = sel ? d.links.filter(l => l.to_id === sel.id).map(l => d.concepts.find(c => c.id === l.from_id)).filter(Boolean) : [];

  $('#edu-page').innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <h2>Knowledge Universe</h2>
        <div class="sub">Every concept is a planet. Mastery is brightness — and it fades unless you return.</div>
      </div>
      <button class="btn" id="exam-btn">${icon('timer', 15)} Exam Simulator</button>
    </div>

    ${d.gaps.length ? `<div class="card gap-card">${d.gaps.slice(0, 2).map(g => `
      <div class="brief-item" data-cid-sel="${g.prereq.id}">${icon('alert', 17, 'important')}<div class="txt"><div class="t"><b>Knowledge gap:</b> ${esc(g.advice)}</div></div>
      <button class="btn small act" data-cid-sel="${g.prereq.id}">Fix it</button></div>`).join('')}</div>` : ''}

    <div class="card" style="padding:8px;margin-top:12px">
      ${d.concepts.length ? `<svg class="edu-svg" viewBox="0 0 ${W} ${H}">
        ${d.links.map(linkLine).join('')}
        ${d.concepts.map(planet).join('')}
      </svg>
      <div class="faint" style="text-align:center;padding:4px 0 8px">brighter = stronger · dimming = time to review · lines = prerequisites · click a planet</div>`
      : `<div class="empty"><span class="big">${icon('planet', 34, 'dim')}</span>Your universe is empty. Add the first concept below — knowledge grows outward from there.</div>`}
    </div>

    <div class="card" style="margin-top:14px">
      ${pickerHtml('ec-pick', 'concept', 'cpu')}
      <div class="add-inline" style="margin-top:10px;margin-bottom:0">
        <input class="input" id="ec-name" placeholder="New concept (e.g. Backpropagation)"/>
        <select class="input" id="ec-prereq" style="max-width:230px">
          <option value="">— standalone —</option>
          ${d.concepts.map(c => `<option value="${c.id}">prerequisite of: ${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn small" id="ec-add">${icon('plus', 13)} Concept</button>
      </div>
    </div>

    ${sel ? `
    <div class="card" style="margin-top:8px" id="edu-detail">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${icon(sel.emoji, 26, 'accent')}
        <div style="flex:1"><b style="font-size:16px">${esc(sel.name)}</b>
          <div class="muted">${sel.effective}% bright${sel.notes ? ' · ' + esc(sel.notes) : ''} · last studied ${timeAgo(sel.last_studied)} ago</div>
          ${prereqsOfSel.length ? `<div class="faint">built on: ${prereqsOfSel.map(p => esc(p.name)).join(', ')}</div>` : ''}
        </div>
        <button class="btn ghost small" id="ec-del">${icon('trash', 13)} Remove</button>
      </div>
      <div class="section-title">I just studied this — how did it go?</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" data-study="1">${icon('alert', 14)} Struggled</button>
        <button class="btn ghost" data-study="2">${icon('check', 14)} Okay</button>
        <button class="btn" data-study="3">${icon('flame', 14)} Nailed it</button>
      </div>
    </div>` : ''}

    ${d.plan.length ? `<div class="section-title">Today's study plan — chosen by the brain</div>
    <div class="card">${d.plan.map(p => {
      const c = d.concepts.find(x => x.id === p.concept_id);
      const pIc = p.kind === 'gap' ? 'alert' : p.kind === 'review' ? 'clock' : 'trend';
      return c ? `<div class="brief-item" data-cid-sel="${c.id}">${icon(pIc, 16, p.kind === 'gap' ? 'important' : 'dim')}<div class="txt"><div class="t">${esc(c.name)}</div><div class="m">${esc(p.why)}</div></div></div>` : '';
    }).join('')}</div>` : ''}

    ${dna && dna.sessions > 0 ? `<div class="section-title">Learning DNA — how you learn, from your own log</div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px">${icon('dna', 20, 'accent')}<div>
        <b>${esc(dna.style.replace(/-/g, ' '))}</b>
        <div class="muted" style="font-size:13px">${esc(dna.styleNote)}</div>
      </div></div>
      <div class="dna-grid">
        <div class="dna-stat"><div class="v">${dna.sessions}</div><div class="k">SESSIONS</div></div>
        <div class="dna-stat"><div class="v">${dna.consistency}%</div><div class="k">CONSISTENCY 14D</div></div>
        <div class="dna-stat"><div class="v">${dna.momentum >= 0 ? '+' : ''}${dna.momentum}</div><div class="k">MOMENTUM WK/WK</div></div>
        ${dna.resilience !== null ? `<div class="dna-stat"><div class="v">${dna.resilience}%</div><div class="k">RESILIENCE</div></div>` : ''}
        ${dna.bestHour !== null ? `<div class="dna-stat"><div class="v">${dna.bestHour}:00</div><div class="k">PEAK HOUR</div></div>` : ''}
      </div>
      <div class="faint" style="margin-top:10px">${esc(dna.engine)}</div>
    </div>` : ''}

    <div class="section-title">Assignments — deadlines with a concept attached</div>
    <div class="card">
      <div class="add-inline">
        <input class="input" id="as-title" placeholder="Problem set 3…"/>
        <select class="input" id="as-concept" style="max-width:190px"><option value="">— no concept —</option>
          ${d.concepts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <input class="input" id="as-due" type="datetime-local" style="max-width:200px" title="Deadline"/>
        <button class="btn small" id="as-add">${icon('plus', 13)}</button>
      </div>
      ${asg.assignments.map(a => `
      <div class="item-row ${a.status === 'done' ? 'done' : ''}">
        <button class="tick" data-as-toggle="${a.id}" data-status="${a.status}">${icon(a.status === 'done' ? 'checkCircle' : 'circleDot', 19, a.status === 'done' ? 'ok' : 'dim')}</button>
        <div class="body"><div class="t">${esc(a.title)}</div>
          <div class="by">${a.concept_name ? esc(a.concept_name) + ' · ' : ''}${a.due_at ? (a.due_at < Date.now() && a.status === 'open' ? '<span class="chip critical" style="font-size:10px;padding:0 7px">overdue</span> ' : '') + 'due ' + new Date(a.due_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'no deadline'}</div>
        </div>
        <button class="btn ghost small" data-as-del="${a.id}">${icon('x', 12)}</button>
      </div>`).join('') || `<div class="faint">Nothing due. Suspicious, but enjoy it.</div>`}
    </div>

    <div class="section-title">Flash cards — recall drills that feed mastery honestly</div>
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <b>${cards.cards.length}</b><span class="muted">card${cards.cards.length === 1 ? '' : 's'} across your universe</span>
        <button class="btn small" id="fc-review" style="margin-left:auto" ${cards.cards.length ? '' : 'disabled'}>${icon('zap', 13)} Review session</button>
      </div>
      <div class="add-inline" style="margin-bottom:0">
        <select class="input" id="fc-concept" style="max-width:170px">${d.concepts.map(c => `<option value="${c.id}" ${c.id === S.eduSel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <input class="input" id="fc-front" placeholder="front — the question"/>
        <input class="input" id="fc-back" placeholder="back — the answer"/>
        <button class="btn small" id="fc-add" ${d.concepts.length ? '' : 'disabled'}>${icon('plus', 13)}</button>
      </div>
    </div>

    <div class="section-title">Study Rooms — learn together, everything in one place</div>
    <div class="card">
      ${rooms.rooms.map(r => `
        <div class="circle-row">
          <span class="cico">${icon(r.emoji, 19)}</span>
          <div style="flex:1"><b>${esc(r.name)}</b><div class="faint">${r.member_count} member${r.member_count === 1 ? '' : 's'} · ${r.notes} notes · ${r.open_questions} open question${r.open_questions === 1 ? '' : 's'}</div></div>
          <button class="btn ghost small" data-room-open="${r.id}">Open</button>
        </div>`).join('') || `<div class="faint" style="margin-bottom:8px">No study rooms yet — chat, notes, questions and tasks in one shared place.</div>`}
      <div class="add-inline" style="margin-bottom:0">
        <input class="input" id="sr-name" placeholder="New study room (e.g. Calc II crew)…" style="max-width:280px"/>
        <button class="btn small" id="sr-add">${icon('plus', 13)} Room</button>
      </div>
    </div>`;

  const rerender = () => renderEdu();
  $('#edu-page').querySelectorAll('[data-cid]').forEach(g => g.onclick = () => { S.eduSel = Number(g.dataset.cid); rerender(); });
  $('#edu-page').querySelectorAll('[data-cid-sel]').forEach(el => el.onclick = () => { S.eduSel = Number(el.dataset.cidSel); rerender(); });
  $('#exam-btn').onclick = () => startExam();
  const getConceptIcon = wirePicker('ec-pick', 'cpu');
  $('#ec-add').onclick = async () => {
    const name = $('#ec-name').value.trim();
    if (!name) return;
    const c = await api('/edu/concepts', { body: { name, emoji: getConceptIcon(), prereqOf: $('#ec-prereq').value || null } }).catch(e => (toast(esc(e.message), true), null));
    if (c) { S.eduSel = c.id; toast(`${icon('planet', 15, 'accent')} A new planet forms.`); rerender(); }
  };
  $('#ec-name') && ($('#ec-name').onkeydown = e => { if (e.key === 'Enter') $('#ec-add').click(); });
  if (sel) {
    $('#edu-detail').querySelectorAll('[data-study]').forEach(b => b.onclick = async () => {
      const c = await api(`/edu/concepts/${sel.id}/study`, { body: { quality: Number(b.dataset.study) } }).catch(() => null);
      if (c) { toast(`${icon('sparkle', 15, 'accent')} ${esc(sel.name)} brightens to ${c.effective}%`); rerender(); }
    });
    $('#ec-del').onclick = async () => {
      await api('/edu/concepts/' + sel.id, { method: 'DELETE' });
      S.eduSel = null; rerender();
    };
  }

  // Assignments (Phase 11)
  $('#as-add').onclick = async () => {
    const title = $('#as-title').value.trim();
    if (!title) return;
    const due = $('#as-due').value ? new Date($('#as-due').value).getTime() : null;
    await api('/edu/assignments', { body: { title, conceptId: $('#as-concept').value || null, dueAt: due } }).catch(e => toast(esc(e.message), true));
    rerender();
  };
  $('#as-title').onkeydown = e => { if (e.key === 'Enter') $('#as-add').click(); };
  $('#edu-page').querySelectorAll('[data-as-toggle]').forEach(b => b.onclick = async () => {
    await api('/edu/assignments/' + b.dataset.asToggle, { method: 'PATCH', body: { status: b.dataset.status === 'done' ? 'open' : 'done' } });
    rerender();
  });
  $('#edu-page').querySelectorAll('[data-as-del]').forEach(b => b.onclick = async () => {
    await api('/edu/assignments/' + b.dataset.asDel, { method: 'DELETE' }); rerender();
  });

  // Flash cards (Phase 11)
  $('#fc-add').onclick = async () => {
    const front = $('#fc-front').value.trim(), back = $('#fc-back').value.trim();
    if (!front || !back) return toast('A card needs a front and a back.', true);
    await api('/edu/flashcards', { body: { conceptId: Number($('#fc-concept').value), front, back } })
      .catch(e => toast(esc(e.message), true));
    toast(`${icon('zap', 14, 'accent')} Card added to the deck.`);
    rerender();
  };
  $('#fc-review').onclick = () => startFlashReview();

  // Study Rooms (Phase 11)
  $('#edu-page').querySelectorAll('[data-room-open]').forEach(b => b.onclick = () => go('/space/' + b.dataset.roomOpen));
  $('#sr-add').onclick = async () => {
    const name = $('#sr-name').value.trim();
    if (!name) return;
    const s = await api('/spaces', { body: { name, emoji: 'book', description: 'Study room', kind: 'study' } })
      .catch(e => (toast(esc(e.message), true), null));
    if (s) go('/space/' + s.id);
  };
}

/* Flash-card review — flip, grade honestly, and the planet updates. */
async function startFlashReview() {
  const d = await api('/edu/flashcards/review').catch(() => null);
  if (!d?.cards.length) return toast('No cards to review yet.', true);
  let i = 0, flipped = false;
  const root = $('#palette-root');
  const close = () => { root.innerHTML = ''; renderEdu(); };
  const draw = () => {
    const c = d.cards[i];
    root.innerHTML = `
    <div class="exam-veil">
      <div class="exam-card">
        <div class="faint" style="display:flex;justify-content:space-between"><span>Card ${i + 1} of ${d.cards.length}</span><span>${esc(c.concept_name)} · ${c.effective}%</span></div>
        <button class="flash-card ${flipped ? 'back' : ''}" id="fc-flip">
          <div class="fc-side">${esc(flipped ? c.back : c.front)}</div>
          <div class="faint" style="margin-top:10px">${flipped ? 'how did you do?' : 'think, then tap to flip'}</div>
        </button>
        ${flipped ? `<div class="exam-acts">
          <button class="btn ghost" data-fg="1">${icon('x', 14)} Blanked</button>
          <button class="btn ghost" data-fg="2">${icon('help', 14)} Shaky</button>
          <button class="btn" data-fg="3">${icon('flame', 14)} Got it</button>
        </div>` : `<div class="exam-acts"><button class="btn ghost" id="fc-skip">skip</button></div>`}
        <div class="faint" style="margin-top:12px;text-align:center">grading updates “${esc(c.concept_name)}” honestly — a blank is data</div>
      </div>
    </div>`;
    $('#fc-flip').onclick = () => { flipped = !flipped; draw(); };
    $('#fc-skip') && ($('#fc-skip').onclick = next);
    root.querySelectorAll('[data-fg]').forEach(b => b.onclick = async () => {
      const r = await api(`/edu/flashcards/${c.id}/grade`, { body: { quality: Number(b.dataset.fg) } }).catch(() => null);
      if (r) toast(`${icon('planet', 14, 'accent')} ${esc(r.concept.name)} → ${r.concept.effective}%`);
      next();
    });
  };
  const next = () => { flipped = false; if (++i < d.cards.length) draw(); else close(); };
  draw();
}

/* Exam Simulator — honest recall under gentle time pressure. Blanks correct
   the record; recalls reinforce it. Ends with a report + retention forecast. */
async function startExam() {
  const d = await api('/edu/exam').catch(() => null);
  if (!d || !d.questions.length) return toast('Add a few concepts first — then the exam has something to measure.', true);

  const results = [];
  let qi = 0, timerId = null;
  const root = $('#palette-root');
  const close = () => { clearInterval(timerId); root.innerHTML = ''; };

  const showQuestion = () => {
    clearInterval(timerId);
    const q = d.questions[qi];
    const started = Date.now();
    let left = q.timeLimitSec;
    root.innerHTML = `
    <div class="exam-veil">
      <div class="exam-card">
        <div class="faint" style="display:flex;justify-content:space-between"><span>Question ${qi + 1} of ${d.questions.length}</span><span id="ex-left">${left}s</span></div>
        <div class="exam-timerbar"><div id="ex-bar" style="width:100%"></div></div>
        <div class="exam-q">${icon(q.emoji, 24, 'accent')} ${esc(q.name)}</div>
        <div class="exam-prompt">${esc(q.prompt)}</div>
        <div class="exam-risk">${q.risk ? `${icon('alert', 13)} ${esc(q.risk)}` : ''}</div>
        <div class="exam-acts">
          <button class="btn ghost" data-ex="blank">${icon('x', 14)} Went blank</button>
          <button class="btn ghost" data-ex="shaky">${icon('help', 14)} Shaky</button>
          <button class="btn" data-ex="nailed">${icon('flame', 14)} Recalled it</button>
        </div>
        <div class="faint" style="margin-top:14px;text-align:center">Honesty is the whole point — a blank is data, not failure.</div>
      </div>
    </div>`;
    timerId = setInterval(() => {
      left--;
      const bar = $('#ex-bar'), lbl = $('#ex-left');
      if (bar) bar.style.width = Math.max(0, (left / q.timeLimitSec) * 100) + '%';
      if (lbl) lbl.textContent = Math.max(0, left) + 's';
      if (left <= 0) answer('blank', started); // time pressure is part of the measurement
    }, 1000);
    root.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => answer(b.dataset.ex, started));
  };

  const answer = (outcome, started) => {
    clearInterval(timerId);
    results.push({ conceptId: d.questions[qi].concept_id, outcome, tookMs: Date.now() - started });
    qi++;
    if (qi < d.questions.length) showQuestion(); else finish();
  };

  const finish = async () => {
    root.innerHTML = `<div class="exam-veil"><div class="exam-card"><div class="empty">Scoring…</div></div></div>`;
    const r = await api('/edu/exam/submit', { body: { results } }).catch(() => null);
    if (!r) return close();
    const nailed = r.report.filter(x => x.outcome === 'nailed').length;
    root.innerHTML = `
    <div class="exam-veil">
      <div class="exam-card">
        <div class="exam-q">${icon('timer', 22, 'accent')} Exam report</div>
        <div class="exam-prompt">${nailed}/${r.report.length} recalled under pressure. Every planet has been updated honestly.</div>
        <div style="margin:14px 0 4px">
          ${r.report.map(x => `<div class="brief-item">
            ${icon(x.outcome === 'nailed' ? 'checkCircle' : x.outcome === 'shaky' ? 'help' : 'x', 16, x.outcome === 'nailed' ? 'ok' : x.outcome === 'shaky' ? 'important' : 'critical')}
            <div class="txt"><div class="t">${esc(x.name)}</div><div class="m">${x.before}% → <b>${x.after}%</b></div></div>
          </div>`).join('')}
        </div>
        ${d.forecast.length ? `<div class="section-title">Retention forecast</div>
        ${d.forecast.map(f => `<div class="brief-item">${icon('clock', 15, 'dim')}<div class="txt"><div class="t">${esc(f.name)}</div><div class="m">drops below 40% in ~${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'}</div></div></div>`).join('')}` : ''}
        <div class="exam-acts"><button class="btn" id="ex-done">Back to the universe</button></div>
      </div>
    </div>`;
    $('#ex-done').onclick = () => { close(); renderEdu(); };
  };

  showQuestion();
}

// ============================================================================
// Ikvizz LIFE — the Digital Home. Rooms of your life; the Garden grows habits.
// ============================================================================
const PLANT_STAGES = [[0, 'seed'], [1, 'sprout'], [7, 'plant'], [14, 'tree']];
const plantFor = streak => PLANT_STAGES.reduce((p, [min, ic]) => streak >= min ? ic : p, 'seed');

async function renderLife() {
  main().innerHTML = `<div class="page"><div class="page-narrow" id="life-page"><div class="empty">Walking into your home…</div></div></div>`;
  const [d, ins] = await Promise.all([
    api('/life').catch(() => null),
    api('/life/insights').catch(() => null),
  ]);
  if (!d || S.view.name !== 'life') return;
  const room = S.lifeRoom && d.rooms.some(r => r.key === S.lifeRoom) ? S.lifeRoom : null;
  const openIn = key => d.items.filter(i => i.room === key && i.status === 'open');
  const overdueIn = key => openIn(key).filter(i => i.due_at && i.due_at < Date.now());

  $('#life-page').innerHTML = `
    <h2>Your Digital Home</h2>
    <div class="sub">Every room is a part of life — walk through it, and the house remembers.</div>

    ${ins?.warnings?.length ? `<div style="margin-bottom:14px">
      ${ins.warnings.map(w => `<div class="insight ${w.severity}" data-room-go="${w.room}">
        ${icon(w.icon, 18, w.severity === 'critical' ? 'critical' : w.severity === 'warn' ? 'important' : 'dim')}
        <div class="t"><b>${esc(w.title)}</b><span>${esc(w.advice)}</span></div>
      </div>`).join('')}
      <div class="faint">${icon('search', 11)} Crisis Predictor · ${esc(ins.engine)}</div>
    </div>` : ''}

    <div class="house">
      <div class="room-grid">
        ${d.rooms.map(r => {
          const open = r.key === 'garden' ? d.habits.length : openIn(r.key).length;
          const od = overdueIn(r.key).length;
          return `<button class="room ${room === r.key ? 'active' : ''}" data-room="${r.key}">
            <span class="em">${icon(r.emoji, 24)}</span><b>${r.label}</b><span class="hint">${r.hint}</span>
            <span class="counts">${od ? `<span class="chip critical" style="font-size:10px;padding:0 7px">${od} overdue</span>` : ''}${open ? `<span class="chip" style="font-size:10px;padding:0 7px">${open}</span>` : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>

    <div class="section-title">${icon('target', 14)} Goals — long arcs, honest progress</div>
    <div class="card" style="margin-bottom:14px">
      ${(d.goals || []).map(g => `
      <div class="item-row ${g.status !== 'open' ? 'done' : ''}">
        <span class="tick">${icon(g.status === 'done' ? 'checkCircle' : 'target', 19, g.status === 'done' ? 'ok' : 'dim')}</span>
        <div class="body">
          <div class="t">${esc(g.title)} <span class="faint">${g.progress}%</span></div>
          <div class="goal-bar"><div style="width:${g.progress}%"></div></div>
          ${g.due_at ? `<div class="by">${g.due_at < Date.now() && g.status === 'open' ? '<span class="chip critical" style="font-size:10px;padding:0 7px">past due</span> ' : ''}by ${new Date(g.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>` : ''}
        </div>
        ${g.status === 'open' ? `<button class="btn ghost small" data-gstep="${g.id}" data-p="${g.progress}" title="+10%">+10%</button>` : ''}
        <button class="btn ghost small" data-gdel="${g.id}">${icon('x', 12)}</button>
      </div>`).join('') || `<div class="faint" style="margin-bottom:8px">No goals yet. Pick one arc worth bending.</div>`}
      <div class="add-inline" style="margin-bottom:0">
        <input class="input" id="gl-title" placeholder="Run a half marathon…" style="max-width:260px"/>
        <input class="input" id="gl-due" type="date" style="max-width:170px" title="Target date"/>
        <button class="btn small" id="gl-add">${icon('plus', 13)} Goal</button>
      </div>
    </div>
    <div id="room-panel"></div>`;

  $('#gl-add').onclick = async () => {
    const title = $('#gl-title').value.trim();
    if (!title) return;
    const due = $('#gl-due').value ? new Date($('#gl-due').value).getTime() : null;
    await api('/life/goals', { body: { title, dueAt: due } }).catch(e => toast(esc(e.message), true));
    renderLife();
  };
  $('#gl-title').onkeydown = e => { if (e.key === 'Enter') $('#gl-add').click(); };
  $('#life-page').querySelectorAll('[data-gstep]').forEach(b => b.onclick = async () => {
    const next = Math.min(100, Number(b.dataset.p) + 10);
    const g = await api('/life/goals/' + b.dataset.gstep, { method: 'PATCH', body: { progress: next } }).catch(() => null);
    if (g?.status === 'done') { toast(`${icon('checkCircle', 15, 'ok')} “${esc(g.title)}” — done. Arc bent.`); runEffect('confetti'); }
    renderLife();
  });
  $('#life-page').querySelectorAll('[data-gdel]').forEach(b => b.onclick = async () => {
    await api('/life/goals/' + b.dataset.gdel, { method: 'DELETE' }); renderLife();
  });

  $('#life-page').querySelectorAll('[data-room]').forEach(b => b.onclick = () => { S.lifeRoom = b.dataset.room; renderLife(); });
  $('#life-page').querySelectorAll('[data-room-go]').forEach(b => b.onclick = () => { S.lifeRoom = b.dataset.roomGo; renderLife(); });
  if (!room) return;

  const meta = d.rooms.find(r => r.key === room);
  const panel = $('#room-panel');

  if (room === 'garden') {
    panel.innerHTML = `
      <div class="section-title">${icon(meta.emoji, 14)} The Garden — habits grow with streaks</div>
      <div class="add-inline"><input class="input" id="hb-name" placeholder="Plant a new habit…" style="max-width:280px"/><button class="btn small" id="hb-add">${icon('sprout', 13)} Plant</button></div>
      ${d.habits.map(h => {
        const doneToday = new Date(h.last_done).toDateString() === new Date().toDateString();
        return `<div class="item-row">
          <span class="tick">${icon(plantFor(h.streak), 26, h.streak >= 7 ? 'ok' : 'dim')}</span>
          <div class="body"><div class="t">${esc(h.name)}</div><div class="by">${h.streak} day streak${doneToday ? ' · done today' : ''}</div></div>
          <button class="btn small ${doneToday ? 'ghost' : ''}" data-hdone="${h.id}" ${doneToday ? 'disabled' : ''}>${doneToday ? icon('check', 13) : 'Done today'}</button>
          <button class="btn ghost small" data-hdel="${h.id}">${icon('x', 12)}</button>
        </div>`;
      }).join('') || `<div class="empty"><span class="big">${icon('seed', 30, 'dim')}</span>Nothing planted yet.</div>`}`;
    $('#hb-add').onclick = async () => {
      const name = $('#hb-name').value.trim();
      if (!name) return;
      await api('/life/habits', { body: { name } }).catch(e => toast(esc(e.message), true));
      renderLife();
    };
    panel.querySelectorAll('[data-hdone]').forEach(b => b.onclick = async () => {
      const h = await api(`/life/habits/${b.dataset.hdone}/done`, { body: {} }).catch(() => null);
      if (h) toast(`${icon(plantFor(h.streak), 16, 'ok')} ${esc(h.name)} — ${h.streak} day streak!`);
      renderLife();
    });
    panel.querySelectorAll('[data-hdel]').forEach(b => b.onclick = async () => {
      await api('/life/habits/' + b.dataset.hdel, { method: 'DELETE' }); renderLife();
    });
    return;
  }

  // Family room = your Trusted Circles (Living Spaces) + care notes
  const circlesHtml = room === 'family' ? await (async () => {
    const sp = await api('/spaces').catch(() => ({ spaces: [] }));
    return `
      <div class="section-title">${icon('users', 14)} Trusted Circles — private spaces for the people who matter</div>
      ${sp.spaces.map(s => `
        <div class="circle-row">
          <span class="cico">${icon(s.emoji, 19)}</span>
          <div style="flex:1"><b>${esc(s.name)}</b><div class="faint">${s.member_count} member${s.member_count > 1 ? 's' : ''} · ${s.open_tasks} open · shared chat, tasks & decisions</div></div>
          <button class="btn ghost small" data-circle="${s.id}">Open</button>
        </div>`).join('')}
      <div class="add-inline"><input class="input" id="fc-name" placeholder="New circle (e.g. Family, Flatmates)…" style="max-width:280px"/><button class="btn small" id="fc-add">${icon('plus', 13)} Circle</button></div>
      <div class="section-title" style="margin-top:18px">${icon('heart', 14)} Care notes</div>`;
  })() : '';

  const items = d.items.filter(i => i.room === room);
  panel.innerHTML = `
    ${circlesHtml || `<div class="section-title">${icon(meta.emoji, 14)} ${meta.label}</div>`}
    <div class="add-inline">
      <input class="input" id="li-title" placeholder="Add to the ${meta.label.toLowerCase()}…"/>
      <input class="input" id="li-due" type="datetime-local" style="max-width:210px" title="Optional deadline"/>
      <button class="btn small" id="li-add">${icon('plus', 14)}</button>
    </div>
    ${items.map(i => `
      <div class="item-row ${i.status === 'done' ? 'done' : ''}">
        <button class="tick" data-ltoggle="${i.id}" data-status="${i.status}">${icon(i.status === 'done' ? 'checkCircle' : 'circleDot', 19, i.status === 'done' ? 'ok' : 'dim')}</button>
        <div class="body"><div class="t">${esc(i.title)}</div>
          ${i.body ? `<div class="b">${esc(i.body)}</div>` : ''}
          ${i.due_at ? `<div class="by">${i.due_at < Date.now() && i.status === 'open' ? '<span class="chip critical" style="font-size:10px;padding:0 7px">overdue</span> ' : ''}due ${new Date(i.due_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>` : ''}
        </div>
        <button class="btn ghost small" data-ldel="${i.id}">${icon('x', 12)}</button>
      </div>`).join('') || `<div class="empty"><span class="big">${icon(meta.emoji, 30, 'dim')}</span>This room is tidy.</div>`}`;
  panel.querySelectorAll('[data-circle]').forEach(b => b.onclick = () => go('/space/' + b.dataset.circle));
  const fcAdd = $('#fc-add');
  if (fcAdd) fcAdd.onclick = async () => {
    const name = $('#fc-name').value.trim();
    if (!name) return;
    const s = await api('/spaces', { body: { name, emoji: 'heart', description: 'Trusted circle' } }).catch(e => (toast(esc(e.message), true), null));
    if (s) go('/space/' + s.id);
  };
  $('#li-add').onclick = async () => {
    const title = $('#li-title').value.trim();
    if (!title) return;
    const due = $('#li-due').value ? new Date($('#li-due').value).getTime() : null;
    await api('/life/items', { body: { room, title, dueAt: due } }).catch(e => toast(esc(e.message), true));
    renderLife();
  };
  $('#li-title').onkeydown = e => { if (e.key === 'Enter') $('#li-add').click(); };
  panel.querySelectorAll('[data-ltoggle]').forEach(b => b.onclick = async () => {
    await api('/life/items/' + b.dataset.ltoggle, { method: 'PATCH', body: { status: b.dataset.status === 'done' ? 'open' : 'done' } });
    renderLife();
  });
  panel.querySelectorAll('[data-ldel]').forEach(b => b.onclick = async () => {
    await api('/life/items/' + b.dataset.ldel, { method: 'DELETE' }); renderLife();
  });
}

// ============================================================================
// Ikvizz HORIZON — everything you know as one living universe.
// Ask it a question and it rearranges: matches pull to the center and ignite.
// ============================================================================
async function renderHorizon() {
  main().innerHTML = `
  <div class="horizon-wrap">
    <input class="input horizon-ask" id="hz-ask" placeholder="Ask the universe… (e.g. startup, invoice, calculus, amma)" autocomplete="off"/>
    <canvas id="hz"></canvas>
    <div class="horizon-legend">${icon('star4', 12)} people · ${worldEnabled('edu') ? `${icon('planet', 12)} knowledge · ` : ''}${icon('orbit', 12)} spaces · ${icon('diamond', 12)} memories · ${icon('comet', 12)} promises — click anything to travel to it</div>
  </div>`;
  const d = await api('/horizon').catch(() => ({ nodes: [] }));
  if (S.view.name !== 'horizon') return;
  if (!worldEnabled('edu')) d.nodes = d.nodes.filter(n => n.type !== 'concept');

  const canvas = $('#hz');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const fit = () => {
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = (wrap.clientHeight - 0) * dpr;
  };
  fit();
  const ctx2 = canvas.getContext('2d');
  const W = () => canvas.width / dpr, H = () => canvas.height / dpr;

  // Background starfield (static)
  const bgStars = Array.from({ length: 130 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + .2, tw: Math.random() * Math.PI * 2 }));

  // Nodes with drift + targets
  const nodes = d.nodes.map((n, i) => {
    const a = (i / Math.max(1, d.nodes.length)) * Math.PI * 2 + (i % 3) * 2.1;
    const r = 90 + (i * 53 % 190);
    return {
      ...n,
      x: 0.5 * 900 + Math.cos(a) * r * 1.4, y: 250 + Math.sin(a) * r,
      tx: null, ty: null, dim: 0, // 0 = normal, 1 = receded
      wob: Math.random() * Math.PI * 2,
    };
  });
  // Scale initial positions to actual canvas
  nodes.forEach(n => { n.x = n.x / 900 * W(); n.y = n.y / 500 * H(); });

  let query = '';
  $('#hz-ask').oninput = e => {
    query = e.target.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(t => t.length > 1);
    if (!tokens.length) { nodes.forEach(n => { n.tx = null; n.ty = null; n.dim = 0; }); return; }
    const matched = nodes.filter(n => tokens.some(t => (n.label + ' ' + n.sub + ' ' + n.body).toLowerCase().includes(t)));
    const rest = nodes.filter(n => !matched.includes(n));
    // The universe rearranges: matches ring the center, the rest recedes.
    matched.forEach((n, i) => {
      const a = (i / Math.max(1, matched.length)) * Math.PI * 2 - Math.PI / 2;
      n.tx = W() / 2 + Math.cos(a) * Math.min(160, W() * 0.18);
      n.ty = H() / 2 + Math.sin(a) * Math.min(120, H() * 0.22);
      n.dim = -0.6; // ignite
    });
    rest.forEach((n, i) => {
      const a = (i / Math.max(1, rest.length)) * Math.PI * 2;
      n.tx = W() / 2 + Math.cos(a) * W() * 0.46;
      n.ty = H() / 2 + Math.sin(a) * H() * 0.46;
      n.dim = 0.75;
    });
  };

  canvas.onclick = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bd = 30;
    for (const n of nodes) {
      const dd = Math.hypot(n.x - mx, n.y - my);
      if (dd < bd) { bd = dd; best = n; }
    }
    if (best?.ref) { if (best.type === 'concept') setWorld('edu'); else go(best.ref); }
  };

  const drawNode = (n, t) => {
    const glow = Math.max(0.08, Math.min(1, n.heat - n.dim));
    const size = 4 + n.weight * 3.2;
    const col = `hsl(${n.hue},72%,${45 + glow * 25}%)`;
    ctx2.save();
    ctx2.translate(n.x, n.y + Math.sin(t / 900 + n.wob) * 3);
    ctx2.globalAlpha = Math.max(0.15, 1 - Math.max(0, n.dim));
    // halo
    const g = ctx2.createRadialGradient(0, 0, 0, 0, 0, size * 3.2);
    g.addColorStop(0, col); g.addColorStop(1, 'transparent');
    ctx2.globalAlpha *= 0.9;
    ctx2.fillStyle = g;
    ctx2.beginPath(); ctx2.arc(0, 0, size * 3.2, 0, 7); ctx2.fill();
    ctx2.globalAlpha = Math.max(0.25, 1 - Math.max(0, n.dim));
    ctx2.fillStyle = col;
    if (n.type === 'person') { // 4-point star
      ctx2.beginPath();
      for (let i = 0; i < 8; i++) {
        const rr = i % 2 ? size * 0.45 : size * 1.5;
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        ctx2[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx2.closePath(); ctx2.fill();
    } else if (n.type === 'space') { // galaxy: ring + core
      ctx2.beginPath(); ctx2.arc(0, 0, size, 0, 7); ctx2.fill();
      ctx2.strokeStyle = col; ctx2.lineWidth = 1.5; ctx2.globalAlpha *= 0.6;
      ctx2.beginPath(); ctx2.ellipse(0, 0, size * 2.1, size * 0.9, t / 4000 + n.wob, 0, 7); ctx2.stroke();
    } else if (n.type === 'promise') { // comet with tail
      ctx2.beginPath(); ctx2.arc(0, 0, size * 0.8, 0, 7); ctx2.fill();
      ctx2.strokeStyle = col; ctx2.lineWidth = 2; ctx2.globalAlpha *= 0.5;
      ctx2.beginPath(); ctx2.moveTo(0, 0); ctx2.lineTo(-size * 3, size * 1.6); ctx2.stroke();
    } else if (n.type === 'memory') { // diamond
      ctx2.beginPath();
      ctx2.moveTo(0, -size); ctx2.lineTo(size * 0.8, 0); ctx2.lineTo(0, size); ctx2.lineTo(-size * 0.8, 0);
      ctx2.closePath(); ctx2.fill();
    } else { // concept planet with ring
      ctx2.beginPath(); ctx2.arc(0, 0, size, 0, 7); ctx2.fill();
      ctx2.strokeStyle = col; ctx2.lineWidth = 1.2; ctx2.globalAlpha *= 0.7;
      ctx2.beginPath(); ctx2.ellipse(0, 0, size * 1.7, size * 0.55, -0.5, 0, 7); ctx2.stroke();
    }
    // label
    ctx2.globalAlpha = Math.max(0.25, 1 - Math.max(0, n.dim));
    ctx2.fillStyle = getComputedStyle(document.body).color;
    ctx2.font = '600 11px system-ui';
    ctx2.textAlign = 'center';
    ctx2.fillText(n.label, 0, size * 1.9 + 12);
    ctx2.globalAlpha *= 0.55;
    ctx2.font = '10px system-ui';
    ctx2.fillText(n.sub, 0, size * 1.9 + 24);
    ctx2.restore();
  };

  const loop = (t) => {
    if (S.view?.name !== 'horizon' || !document.body.contains(canvas)) return; // view left — stop cleanly
    fit();
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, W(), H());
    for (const s of bgStars) {
      ctx2.globalAlpha = 0.25 + 0.25 * Math.sin(t / 1400 + s.tw);
      ctx2.fillStyle = '#9db0d8';
      ctx2.beginPath(); ctx2.arc(s.x * W(), s.y * H(), s.r, 0, 7); ctx2.fill();
    }
    ctx2.globalAlpha = 1;
    for (const n of nodes) {
      if (n.tx !== null) { n.x += (n.tx - n.x) * 0.06; n.y += (n.ty - n.y) * 0.06; }
      else { n.x += Math.sin(t / 3000 + n.wob) * 0.12; n.y += Math.cos(t / 3400 + n.wob) * 0.1; }
      drawNode(n, t);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  $('#hz-ask').focus();
}

// -------------------------------------------------------- command palette -----
let palOpen = false;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.me) togglePalette(); }
  if (e.key === 'Escape' && palOpen) togglePalette(false);
});

function togglePalette(force) {
  palOpen = force ?? !palOpen;
  const root = $('#palette-root');
  if (!palOpen) { root.innerHTML = ''; return; }
  // Context Search (Phase 10): narrow the lens, or search inside THIS chat
  const scopes = [['all', 'everything'], ['message', 'messages'], ['memory', 'memories'], ['space_item', 'space items']];
  if (S.chat) scopes.push(['here', 'this chat']);
  let scope = 'all';
  root.innerHTML = `
  <div class="palette-veil" id="pal-veil">
    <div class="palette">
      <input id="pal-input" placeholder="Search everything you've ever said, saved, or decided…" autocomplete="off" />
      <div class="filter-pills" id="pal-scopes" style="padding:8px 14px 0">
        ${scopes.map(([k, l]) => `<button data-scope="${k}" class="${k === 'all' ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="results" id="pal-results"><div class="empty" style="padding:22px">Your entire relationship history is searchable.</div></div>
      <div class="hint"><kbd>↵</kbd> open · <kbd>Esc</kbd> close — searches messages, memories, space items and people</div>
    </div>
  </div>`;
  $('#pal-veil').onmousedown = e => { if (e.target.id === 'pal-veil') togglePalette(false); };
  const input = $('#pal-input');
  input.focus();
  let seq = 0;
  $('#pal-scopes').querySelectorAll('[data-scope]').forEach(b => b.onclick = () => {
    scope = b.dataset.scope;
    $('#pal-scopes').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
  input.oninput = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { $('#pal-results').innerHTML = ''; return; }
    const filter = scope === 'here' ? `&in=${S.chat?.conversationId || 0}` : scope !== 'all' ? `&kind=${scope}` : '';
    const d = await api('/search?q=' + encodeURIComponent(q) + filter).catch(() => null);
    if (!d || my !== seq || !palOpen) return;
    const rows = [
      ...(d.people || []).map(p => ({ k: 'person', label: `<b>${esc(p.display_name)}</b> · ${esc(p.kind)}`, go: () => { const pp = S.people.find(x => x.other_id === p.id); if (pp) go('/chat/' + pp.conversation_id); } })),
      ...(d.results || []).map(r => {
        const snip = esc(r.snippet).replaceAll('⟪', '<span class="hl">').replaceAll('⟫', '</span>');
        if (r.kind === 'message') return { k: 'message', label: `${r.from ? `<b>${esc(r.from)}</b>: ` : ''}${snip}`, go: () => go('/chat/' + r.conversation_id) };
        if (r.kind === 'memory') return { k: 'memory', label: snip, go: () => go('/memory') };
        return { k: r.type || 'item', label: `${snip}`, go: () => go('/space/' + r.space_id) };
      }),
    ];
    $('#pal-results').innerHTML = rows.length
      ? rows.map((r, i) => `<button class="pal-row ${i === 0 ? 'sel' : ''}" data-i="${i}"><span class="k">${r.k}</span><span class="s">${r.label}</span></button>`).join('')
      : `<div class="empty" style="padding:22px">Nothing yet for “${esc(q)}”.</div>`;
    document.querySelectorAll('.pal-row').forEach(b => b.onclick = () => { togglePalette(false); rows[Number(b.dataset.i)].go(); });
    input.onkeydown = e => {
      const sel = $('.pal-row.sel');
      if (e.key === 'Enter' && sel) { togglePalette(false); rows[Number(sel.dataset.i)].go(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...document.querySelectorAll('.pal-row')];
        let i = all.indexOf(sel) + (e.key === 'ArrowDown' ? 1 : -1);
        i = Math.max(0, Math.min(all.length - 1, i));
        sel?.classList.remove('sel'); all[i]?.classList.add('sel'); all[i]?.scrollIntoView({ block: 'nearest' });
      }
    };
  };
}

// ------------------------------------------------------------------- init -----
const savedTheme = localStorage.getItem('aether_theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
const savedAccent = localStorage.getItem('aether_accent');
if (savedAccent) document.documentElement.dataset.accent = savedAccent;
// Ikvizz Luxe (champagne pearl) is the new signature skin. Roll it out once as
// the default — respecting any explicit choice the user makes afterwards.
if (!localStorage.getItem('aether_skin_v3')) {
  localStorage.setItem('aether_skin', 'pearl');
  localStorage.setItem('aether_skin_v3', '1');
}
document.documentElement.dataset.skin = localStorage.getItem('aether_skin') || 'pearl';

// Register the service worker for install support (independent of push, which
// asks separately for permission). Silent if unsupported.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Accessibility: every icon-only button carries a human `title`; mirror it into
// `aria-label` so screen readers announce "Send" / "Voice call" instead of
// "button, button, button". One observer covers every current + future render.
function labelIcons(root = document) {
  root.querySelectorAll?.('button[title]:not([aria-label])').forEach(b => {
    const t = b.getAttribute('title');
    if (t) b.setAttribute('aria-label', t);
  });
}
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) labelIcons(n);
}).observe(document.documentElement, { childList: true, subtree: true });

boot();
