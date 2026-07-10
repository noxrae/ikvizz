// Verify Confession Train (anonymous) + Music Sync (socket relay). Free-tier.
import { io } from 'socket.io-client';
const BASE = 'http://localhost:4321';
const login = async u => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'aether123' }) })).json()).token;
const api = (tok, path, opts = {}) => fetch(BASE + '/api' + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(x => x.json().catch(() => ({})));
const results = []; const ok = (n, c) => results.push([n, !!c]);

const [tokA, tokR] = await Promise.all([login('aarav'), login('rahul')]);

// --- Confession Train ---
const posted = await api(tokA, '/confessions', { body: { body: 'i still think about that one text from 2019' } });
ok('confession posted', posted.ok && posted.id);
const next = await api(tokR, '/confessions/next');
ok('rahul receives a confession on the train', next.confession && typeof next.confession.body === 'string');
ok('confession is anonymous (author tag, no id)', next.confession?.author?.startsWith('anon') && next.confession.author_id === undefined);
const authorLeak = JSON.stringify(next.confession || {}).includes('"author_id"');
ok('no author_id leaks to client', !authorLeak);
const replied = await api(tokR, `/confessions/${next.confession.id}/reply`, { body: { body: 'same energy honestly' } });
ok('anonymous reply accepted', replied.ok && replied.reply.author?.startsWith('anon'));
const mine = await api(tokA, '/confessions/mine');
ok('author sees replies on their own confession', mine.confessions?.some(c => c.replies.length > 0));
const selfServe = await api(tokA, '/confessions/next');
ok('you never get served your own confession', !selfServe.confession || selfServe.confession.body !== 'i still think about that one text from 2019');
const empty = await api(tokA, '/confessions', { body: { body: 'x' } });
ok('too-short confession rejected', !!empty.error);

// --- Music Sync (socket relay) ---
const a = io(BASE, { auth: { token: tokA } });
const r = io(BASE, { auth: { token: tokR } });
await Promise.all([new Promise(res => a.on('connect', res)), new Promise(res => r.on('connect', res))]);
a.emit('conversation:join', 1); r.emit('conversation:join', 1);
await new Promise(res => setTimeout(res, 150));
const musicSeen = new Promise(res => r.once('music:sync', d => res(d)));
a.emit('music:sync', { conversationId: 1, action: 'start', url: '/files/fake-clip.mp3', t: 0, at: Date.now() });
const mEvt = await Promise.race([musicSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('music start relayed to the other listener', mEvt?.action === 'start' && mEvt.url === '/files/fake-clip.mp3');
const playSeen = new Promise(res => r.once('music:sync', d => res(d)));
a.emit('music:sync', { conversationId: 1, action: 'play', url: '/files/fake-clip.mp3', t: 5, at: Date.now() });
const pEvt = await Promise.race([playSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('music play/seek relayed with position', pEvt?.action === 'play' && pEvt.t === 5);
// a non-member must not be able to inject into the room
const m = io(BASE, { auth: { token: await login('maya') } });
await new Promise(res => m.on('connect', res));
let leaked = false;
r.on('music:sync', d => { if (d.from && d.action === 'start' && d.url === '/files/intruder.mp3') leaked = true; });
m.emit('music:sync', { conversationId: 1, action: 'start', url: '/files/intruder.mp3', t: 0, at: Date.now() });
await new Promise(res => setTimeout(res, 400));
ok('non-member cannot inject music into a DM', !leaked);

console.log('\n=== CHAOS LAYER RESULTS ===');
let pass = 0;
for (const [n, g] of results) { console.log((g ? 'PASS' : 'FAIL') + '  ' + n); if (g) pass++; }
console.log(`${pass}/${results.length} passed`);
[a, r, m].forEach(s => s.close());
process.exit(pass === results.length ? 0 : 1);
