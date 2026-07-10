// Integration test: Cloud Messaging mirror (Milestone 4) — real Supabase.
// Server must be running (npm start) with SUPABASE_DB_URL + SUPABASE_SERVICE_KEY
// in .env. Drives the app exactly like a user (REST + sockets), then checks
// that every core-messaging write landed in the Supabase Postgres schema.
import { io } from 'socket.io-client';
import pg from 'pg';

const BASE = 'http://localhost:4321';
const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('Run with: npm run test:cloud (needs SUPABASE_DB_URL in .env)');
  process.exit(1);
}
const cloud = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 1 });
const q = (sql, params = []) => cloud.query(sql, params);

const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); };

/** Poll until fn() returns truthy (the mirror is async by design). */
async function until(fn, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise(r => setTimeout(r, 800));
  }
}

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

const [tokA, tokR] = await Promise.all([login('aarav'), login('rahul')]);
ok('login both users', tokA && tokR);
const sockA = io(BASE, { auth: { token: tokA } });
await new Promise(res => sockA.on('connect', res));
const emit = (ev, payload) => new Promise(res => sockA.emit(ev, payload, res));

const marker = 'M4 cloud mirror check ' + Math.random().toString(36).slice(2);

// -- 1) a DM message reaches public.messages with chat + members + sender ----
const sent = (await authed(tokA, '/conversations/1/messages', { body: { body: marker } })).message;
ok('message sent locally', !!sent?.id);

const cloudMsg = await until(async () =>
  (await q(`SELECT * FROM public.messages WHERE body=$1`, [marker])).rows[0]);
ok('message mirrored to Supabase', !!cloudMsg);
ok('priority + signals travel along', cloudMsg && cloudMsg.priority && Array.isArray(cloudMsg.signals));

const chat = cloudMsg && (await q(`SELECT * FROM public.chats WHERE id=$1`, [cloudMsg.chat_id])).rows[0];
ok('chat mirrored as dm', chat?.kind === 'dm');
const members = cloudMsg && (await q(`SELECT user_id FROM public.chat_members WHERE chat_id=$1`, [cloudMsg.chat_id])).rows;
ok('both members present in cloud chat', members?.length === 2);

const sender = cloudMsg && (await q(`SELECT * FROM public.profiles WHERE id=$1`, [cloudMsg.sender_id])).rows[0];
ok('shadow identity carries the username', sender?.username?.startsWith('aarav'));

// -- 2) replies keep their quote across the mirror ---------------------------
const replyMarker = marker + ' reply';
await authed(tokR, '/conversations/1/messages', { body: { body: replyMarker, replyTo: sent.id } });
const cloudReply = await until(async () =>
  (await q(`SELECT * FROM public.messages WHERE body=$1`, [replyMarker])).rows[0]);
ok('reply mirrored with reply_to mapped', cloudReply && cloudReply.reply_to === cloudMsg.id);

// -- 3) edits re-mirror (body + edited_at) -----------------------------------
await emit('message:edit', { messageId: sent.id, body: marker + ' EDITED' });
const edited = await until(async () => {
  const r = (await q(`SELECT * FROM public.messages WHERE id=$1`, [cloudMsg.id])).rows[0];
  return r?.body === marker + ' EDITED' && r.edited_at ? r : null;
});
ok('edit mirrored (body + edited_at)', !!edited);

// -- 4) reactions sync current state -----------------------------------------
await emit('reaction:toggle', { messageId: sent.id, kind: 'flame' });
const reacted = await until(async () =>
  (await q(`SELECT * FROM public.message_reactions WHERE message_id=$1 AND kind='flame'`, [cloudMsg.id])).rows[0]);
ok('reaction mirrored', !!reacted);
await emit('reaction:toggle', { messageId: sent.id, kind: 'flame' }); // toggle off
const unreacted = await until(async () =>
  !(await q(`SELECT 1 FROM public.message_reactions WHERE message_id=$1`, [cloudMsg.id])).rowCount);
ok('reaction removal mirrored', !!unreacted);

// -- 5) read markers land in message_reads -----------------------------------
await authed(tokR, '/conversations/1/read', { body: {} });
const read = await until(async () => {
  const r = await q(`
    SELECT 1 FROM public.message_reads mr JOIN public.profiles p ON p.id = mr.user_id
    WHERE mr.chat_id=$1 AND p.username LIKE 'rahul%'`, [cloudMsg.chat_id]);
  return r.rowCount;
});
ok('read marker mirrored', !!read);

// -- 6) media: upload → storage object + attachments row ---------------------
const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
const up = await authed(tokA, '/upload', { body: { name: 'cloud-dot.png', type: 'image/png', dataBase64: png1x1 } });
const attMsg = await authed(tokA, '/conversations/1/messages', { body: { body: marker + ' with media', attachment: up } });
const cloudAtt = await until(async () => {
  const m = (await q(`SELECT id FROM public.messages WHERE body=$1`, [marker + ' with media'])).rows[0];
  if (!m) return null;
  return (await q(`SELECT * FROM public.attachments WHERE message_id=$1`, [m.id])).rows[0];
});
ok('attachment row mirrored', !!cloudAtt);
const stored = cloudAtt && await until(async () =>
  (await q(`SELECT 1 FROM storage.objects WHERE bucket_id=$1 AND name=$2`, [cloudAtt.bucket, cloudAtt.path])).rowCount);
ok('file bytes live in Supabase Storage', !!stored);

// -- 7) polls: options + votes ------------------------------------------------
const pollAck = await emit('message:send', { conversationId: 1, body: marker + ' poll?', pollOptions: ['tea', 'coffee'] });
await emit('poll:vote', { messageId: pollAck.message.id, opt: 1 });
const cloudVote = await until(async () => {
  const m = (await q(`SELECT id FROM public.messages WHERE body=$1 AND kind='poll'`, [marker + ' poll?'])).rows[0];
  if (!m) return null;
  return (await q(`SELECT * FROM public.poll_votes WHERE message_id=$1 AND opt=1`, [m.id])).rows[0];
});
ok('poll + vote mirrored', !!cloudVote);

// -- 8) moments become cloud stories ------------------------------------------
const story = await authed(tokA, '/stories', { body: { kind: 'text', body: marker + ' moment' } });
const cloudStory = await until(async () =>
  (await q(`SELECT * FROM public.stories WHERE body=$1`, [marker + ' moment'])).rows[0]);
ok('moment mirrored to public.stories', !!cloudStory);
await authed(tokA, `/stories/${story.id}`, { method: 'DELETE' });
const storyGone = await until(async () =>
  !(await q(`SELECT 1 FROM public.stories WHERE body=$1`, [marker + ' moment'])).rowCount);
ok('moment deletion mirrored', !!storyGone);

// -- 9) deletes tombstone the cloud row ---------------------------------------
await emit('message:delete', { messageId: sent.id });
const tombstone = await until(async () => {
  const r = (await q(`SELECT * FROM public.messages WHERE id=$1`, [cloudMsg.id])).rows[0];
  return r?.deleted === true && r.body === '' ? r : null;
});
ok('delete mirrored as tombstone (deleted + empty body)', !!tombstone);

// -- 10) sealed messages mirror as ciphertext only -----------------------------
const sealedAck = await emit('message:send', { conversationId: 1, kind: 'sealed', body: JSON.stringify({ ct: 'AAAA', iv: 'BBBB', marker }) });
const cloudSealed = await until(async () =>
  (await q(`SELECT * FROM public.messages WHERE id IS NOT NULL AND kind='sealed' AND body LIKE $1`, ['%' + marker + '%'])).rows[0]);
ok('sealed message mirrored as ciphertext (kind=sealed)', !!cloudSealed);
ok('sealed message carries no signals to the cloud', cloudSealed && cloudSealed.signals.length === 0);

// -- teardown: remove this run's noise from the cloud --------------------------
if (cloudMsg) await q(`DELETE FROM public.messages WHERE body LIKE $1 OR id=$2`, [marker + '%', cloudMsg.id]).catch(() => {});
sockA.close();
await cloud.end();

let pass = 0;
for (const [name, good] of results) {
  console.log(`${good ? '✔' : '✘'} ${name}`);
  if (good) pass++;
}
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
