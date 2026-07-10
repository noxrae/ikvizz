// View-once photo: opens exactly once, then stays gone — even after a reload.
import { io } from 'socket.io-client';

const BASE = 'http://localhost:4321';
const results = [];
const ok = (name, cond) => results.push([name, !!cond]);

async function login(username) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'aether123' }),
  });
  return (await r.json()).token;
}
const authed = (tok, path, opts = {}) => fetch(BASE + '/api' + path, {
  method: opts.method || (opts.body ? 'POST' : 'GET'),
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(x => x.json().catch(() => ({})));

const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';

// aarav (id 1) ↔ rahul (id 2) share DM convo 1.
const [tokA, tokR] = await Promise.all([login('aarav'), login('rahul')]);
ok('login both users', tokA && tokR);

const a = io(BASE, { auth: { token: tokA } });
const r = io(BASE, { auth: { token: tokR } });
await Promise.all([new Promise(res => a.on('connect', res)), new Promise(res => r.on('connect', res))]);
a.emit('conversation:join', 1);
r.emit('conversation:join', 1);
await new Promise(res => setTimeout(res, 150));

// Aarav uploads a photo and sends it as VIEW-ONCE.
const up = await authed(tokA, '/upload', { body: { name: 'secret.png', type: 'image/png', dataBase64: png1x1 } });
ok('upload ok', up.url?.startsWith('/files/'));

const recvNew = new Promise(res => r.once('message:new', d => res(d)));
const ack = await new Promise(res => a.emit('message:send', { conversationId: 1, body: '', attachment: up, viewOnce: true }, res));
ok('send acked', ack?.ok);
const voId = ack?.message?.id;
ok('view-once signal present', (ack?.message?.signals || []).some(s => s.type === 'viewonce'));
ok('sender payload carries NO url', !ack?.message?.attachment);

const broadcast = await Promise.race([recvNew, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('recipient got the message', !!broadcast?.message);
ok('recipient broadcast carries NO url', !broadcast?.message?.attachment);

// History (a fresh "reload") must not leak the URL before opening.
const hist1 = await authed(tokR, '/conversations/1/messages');
const inHist1 = (hist1.messages || []).find(m => m.id === voId);
ok('history hides url before open', inHist1 && !inHist1.attachment);
ok('history keeps viewonce signal', (inHist1?.signals || []).some(s => s.type === 'viewonce' && !s.opened));

// Sender may NOT replay their own view-once photo.
const senderTry = await new Promise(res => a.emit('message:viewonce:open', { messageId: voId }, res));
ok('sender cannot replay', !senderTry?.ok);

// Recipient opens it once → gets the URL.
const opened = await new Promise(res => r.emit('message:viewonce:open', { messageId: voId }, res));
ok('recipient opens once, gets url', opened?.ok && opened.url?.startsWith('/files/'));

// Opening again fails — it's spent.
const again = await new Promise(res => r.emit('message:viewonce:open', { messageId: voId }, res));
ok('cannot open twice', !again?.ok);

// After a reload, it stays gone and shows opened.
const hist2 = await authed(tokR, '/conversations/1/messages');
const inHist2 = (hist2.messages || []).find(m => m.id === voId);
ok('still no url after reload', inHist2 && !inHist2.attachment);
ok('signal marked opened after reload', (inHist2?.signals || []).some(s => s.type === 'viewonce' && s.opened));

a.close(); r.close();
let pass = 0;
for (const [name, cond] of results) { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (cond) pass++; }
console.log(`${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
