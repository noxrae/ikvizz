// Integration test: two users, live message + intent + read + context flow
import { io } from 'socket.io-client';

const BASE = 'http://localhost:4321';
async function login(username) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'aether123' }),
  });
  return (await r.json()).token;
}

const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); };

const [tokA, tokR] = await Promise.all([login('aarav'), login('rahul')]);
ok('login both users', tokA && tokR);

const a = io(BASE, { auth: { token: tokA } });
const r = io(BASE, { auth: { token: tokR } });
await Promise.all([new Promise(res => a.on('connect', res)), new Promise(res => r.on('connect', res))]);
ok('sockets connected', true);

// Both join convo 1 (aarav ↔ rahul DM)
a.emit('conversation:join', 1);
r.emit('conversation:join', 1);
await new Promise(res => setTimeout(res, 150));

// Rahul streams intent → Aarav should see "thinking"/"writing"
const intentSeen = new Promise(res => a.once('intent', d => res(d)));
r.emit('intent', { conversationId: 1, draftLength: 250, msSinceKeystroke: 100 });
const intent = await Promise.race([intentSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('intent received: ' + intent?.intent, intent && intent.intent === 'writing');

// Rahul sends a critical message → Aarav gets message:new with priority
const msgSeen = new Promise(res => a.once('message:new', d => res(d)));
r.emit('message:send', { conversationId: 1, body: 'URGENT: the incubator call moved to today, join asap!' });
const msg = await Promise.race([msgSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('live message received', !!msg);
ok('priority classified critical', msg?.message?.priority === 'critical');

// Aarav reads → Rahul gets read receipt
const readSeen = new Promise(res => r.once('read', d => res(d)));
a.emit('conversation:read', 1);
const read = await Promise.race([readSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('read receipt received', read && read.userId === 1);

// Rahul changes context → Aarav (inner circle) sees it
const ctxSeen = new Promise(res => a.once('context', d => res(d)));
r.emit('context:set', { context: 'driving', note: '', scope: 'all' });
const ctx = await Promise.race([ctxSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('context broadcast: ' + ctx?.context, ctx?.context === 'driving');

// Security: rahul must NOT be able to join maya↔aarav convo (id 2) and receive messages
const tokM = await login('maya');
const m = io(BASE, { auth: { token: tokM } });
await new Promise(res => m.on('connect', res));
r.emit('conversation:join', 2); // rahul tries to snoop on convo 2 (aarav↔maya)
await new Promise(res => setTimeout(res, 150));
let snooped = false;
r.on('message:new', d => { if (d.conversationId === 2) snooped = true; });
m.emit('conversation:join', 2);
await new Promise(res => setTimeout(res, 100));
m.emit('message:send', { conversationId: 2, body: 'private note to aarav' });
await new Promise(res => setTimeout(res, 400));
ok('access control: rahul cannot snoop DMs', !snooped);

// ---------------------------------------------------------------------------
// New feature tests: upload, sealed E2E messages, AI summary
// ---------------------------------------------------------------------------
const authed = (tok, path, opts = {}) => fetch(BASE + '/api' + path, {
  method: opts.method || (opts.body ? 'POST' : 'GET'),
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(x => x.json().catch(() => ({})));

// 1) Upload a tiny PNG and send it as an attachment
const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
const up = await authed(tokA, '/upload', { body: { name: 'dot.png', type: 'image/png', dataBase64: png1x1 } });
ok('upload returns /files url', up.url?.startsWith('/files/'));
// /files is now gated by the session cookie (browsers send it automatically via <img>).
// Node fetch has no cookie jar, so grab the cookie from a login and pass it explicitly.
const loginResp = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'aarav', password: 'aether123' }) });
const sessCookie = (loginResp.headers.get('set-cookie') || '').split(';')[0];
const fileNoAuth = await fetch(BASE + up.url);
ok('uploaded file blocked without session', fileNoAuth.status === 403);
const fileServed = await fetch(BASE + up.url, { headers: { Cookie: sessCookie } });
ok('uploaded file served with session', fileServed.ok);
const attMsg = await authed(tokA, '/conversations/1/messages', { body: { body: 'here is the logo', attachment: up } });
ok('attachment message stored', attMsg.message?.attachment?.url === up.url);

// 2) Bad upload rejected
const bad = await authed(tokA, '/upload', { body: { name: 'evil.exe', type: 'application/x-msdownload', dataBase64: png1x1 } });
ok('exe upload rejected', !!bad.error);

// 3) Sealed message: send ciphertext-shaped body with bait keywords, verify the brain goes blind
const sealedBody = JSON.stringify({ iv: 'AAAAAAAAAAAAAAAA', ct: 'VVJHRU5UIEkgd2lsbCBzZW5kIGl0IGJ5IEZyaWRheQ==' });
const sealed = await authed(tokA, '/conversations/1/messages', { body: { kind: 'sealed', body: sealedBody } });
ok('sealed msg accepted', !!sealed.message?.id);
ok('sealed msg: priority NOT classified', sealed.message?.priority === 'normal');
ok('sealed msg: NO signals extracted', sealed.message?.signals?.length === 0);
const search = await authed(tokA, '/search?q=VVJHRU5U');
ok('sealed msg: NOT in search index', !(search.results || []).some(x => x.id === sealed.message?.id));
const people = await authed(tokA, '/people');
const rahulRow = people.people.find(p => p.username === 'rahul');
ok('sealed msg: masked in people list', rahulRow?.last_message?.body === 'Encrypted message');

// 4) Public key publish + readable via profile
await authed(tokA, '/me/pubkey', { body: { publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'testx', y: 'testy' }) } });
const prof = await authed(tokR, '/people/1/profile');
ok('pubkey published and visible to peer', typeof prof.public_key === 'string' && prof.public_key.includes('testx'));

// 4.3) Chat enhancements: replies, reactions, edit, delete
const replied = await authed(tokA, '/conversations/1/messages', { body: { body: 'replying to your idea', replyTo: 1 } });
ok('reply: sent with reply_to', replied.message?.reply_to === 1);
const fetched = await authed(tokA, '/conversations/1/messages');
const fReplied = fetched.messages.find(m => m.id === replied.message.id);
ok('reply: quoted preview enriched', fReplied?.reply?.name && typeof fReplied.reply.body === 'string');
ok('reactions: seeded reactions present', fetched.messages.some(m => (m.reactions || []).length > 0));
ok('seen: othersReadTo exposed', typeof fetched.othersReadTo === 'number');

// live reaction toggle: rahul reacts, aarav sees the update
const reactSeen = new Promise(res => a.once('reaction:update', d => res(d)));
r.emit('reaction:toggle', { messageId: replied.message.id, kind: 'flame' });
const reactEvt = await Promise.race([reactSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('reactions: live update received', reactEvt?.reactions?.some(x => x.kind === 'flame'));

// live edit: aarav edits own message, rahul receives it
const editSeen = new Promise(res => r.once('message:edited', d => res(d)));
a.emit('message:edit', { messageId: replied.message.id, body: 'edited: replying to your idea, urgent deadline!' });
const editEvt = await Promise.race([editSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('edit: broadcast with re-classified priority', editEvt?.message?.edited_at > 0 && editEvt.message.priority !== 'normal');

// rahul cannot edit aarav's message
const foreignEdit = await new Promise(res => r.emit('message:edit', { messageId: replied.message.id, body: 'hijack' }, res));
ok('edit: rejected for non-author', foreignEdit?.ok === false);

// live delete
const delSeen = new Promise(res => r.once('message:deleted', d => res(d)));
a.emit('message:delete', { messageId: replied.message.id });
const delEvt = await Promise.race([delSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('delete: broadcast received', delEvt?.messageId === replied.message.id);
const afterDel = await authed(tokA, '/conversations/1/messages');
ok('delete: soft-deleted with empty body', afterDel.messages.find(m => m.id === replied.message.id)?.deleted === 1);

// 4.35) New innovations: capsules, silent, moods, reminders, drift, phone discovery
const capsule = await authed(tokA, '/conversations/1/messages', { body: { body: 'secret for the future', unlockAt: Date.now() + 30 * 86400000 } });
ok('capsule: accepted', !!capsule.message?.id);
const capFetch = await authed(tokA, '/conversations/1/messages');
const capMsg = capFetch.messages.find(m => m.id === capsule.message.id);
ok('capsule: body hidden even from sender', capMsg?.body === '' && capMsg?.locked === true);
const capSearch = await authed(tokA, '/search?q=secret');
ok('capsule: not in search index', !(capSearch.results || []).some(x => x.id === capsule.message.id));

const silent = await authed(tokA, '/conversations/1/messages', { body: { body: 'urgent deadline asap!!', silent: true } });
ok('silent: never interrupts (priority forced normal)', silent.message?.priority === 'normal' && silent.message?.signals?.some(s => s.type === 'silent'));

const moodMsg = await authed(tokA, '/conversations/1/messages', { body: { body: 'we should celebrate', mood: 'hyped' } });
ok('mood tag: emotion layer attached', moodMsg.message?.signals?.some(s => s.type === 'mood' && s.kind === 'hyped'));

const moodReact = await new Promise(res => r.emit('reaction:toggle', { messageId: moodMsg.message.id, kind: 'love' }, res));
ok('mood reactions: blob kinds accepted', moodReact?.ok === true);

await authed(tokA, '/me/mood', { method: 'PATCH', body: { mood: 'jk' } });
const meNow = await authed(tokA, '/me');
ok('mood canvas: saved + returned', meNow.user?.mood === 'jk');

const rem = await authed(tokA, '/people/2/reminders', { body: { body: 'ask about the incubator call' } });
ok('reminder: created for person', !!rem.id);
const remList = await authed(tokA, '/people/2/reminders');
ok('reminder: surfaces for that chat', remList.reminders?.some(x => x.id === rem.id));
await authed(tokA, '/reminders/' + rem.id, { method: 'PATCH', body: {} });

const brief2 = await authed(tokA, '/briefing');
ok('relationship health: dev is drifting (' + (brief2.drifting?.[0]?.daysSilent ?? '?') + 'd)', brief2.drifting?.some(d => d.display_name === 'Dev Menon' && d.daysSilent > 30));

const uniq = String(Date.now()).slice(-8);
await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'temp' + uniq, password: 'aether123', phone: '+9177' + uniq }) });
const byPhone = await authed(tokM, '/people', { body: { username: '+91 77' + uniq, kind: 'Friend' } });
ok('phone discovery: add person by number', byPhone.ok === true);
const dupPhone = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phonethief', password: 'aether123', phone: '+919876500001' }) }).then(x => x.json());
ok('phone discovery: duplicate number rejected', !!dupPhone.error);

// 4.38) Accounts & ownership: google config, pin/mute, forward, export, avatar
const gcfg = await fetch(BASE + '/api/auth/config').then(x => x.json());
ok('google: config endpoint answers (configured: ' + !!gcfg.googleClientId + ')', 'googleClientId' in gcfg);
const gtry = await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: 'fake' }) }).then(x => x.json());
ok('google: fake credential rejected', !!gtry.error);

const pplX = await authed(tokA, '/people');
const mayaRel = pplX.people.find(p => p.username === 'maya');
await authed(tokA, '/people/' + mayaRel.relationship_id, { method: 'PATCH', body: { pinned: true, muted: true } });
const pplY = await authed(tokA, '/people');
const mayaNow = pplY.people.find(p => p.username === 'maya');
ok('pin/mute: persisted', mayaNow.pinned === true && mayaNow.muted === true);
await authed(tokA, '/people/' + mayaRel.relationship_id, { method: 'PATCH', body: { pinned: false, muted: false } });

const fwd = await authed(tokA, '/conversations/2/messages', { body: { body: 'check this out', forwarded: true } });
ok('forward: REST path carries fwd signal', fwd.message?.signals?.some(s => s.type === 'fwd') === true);

const fwdSock = await new Promise(res => a.emit('message:send', { conversationId: 2, body: 'fwd via socket', forwarded: true }, res));
ok('forward: socket path carries fwd signal', fwdSock?.ok && fwdSock.message?.signals?.some(s => s.type === 'fwd'));

const exp = await authed(tokA, '/export');
ok('export: full universe returned', exp.user?.username === 'aarav' && Array.isArray(exp.messages) && exp.messages.length > 5 && Array.isArray(exp.relationships) && Array.isArray(exp.memories));
ok('export: locked capsules stay sealed', !exp.messages.some(m => m.unlock_at > Date.now() && m.body !== '[sealed time capsule]'));

const badAvatar = await authed(tokA, '/me', { method: 'PATCH', body: { avatarUrl: 'https://evil.example/x.png' } });
ok('avatar: foreign URLs rejected', !!badAvatar.error);

// 4.39) Competitive parity: polls, mentions, calls signaling, moments, email login
const poll = await authed(tokA, '/conversations/1/messages', { body: { body: 'best name?', pollOptions: ['Aether', 'Nimbus', 'Loop'] } });
ok('poll: created with options', poll.message?.kind === 'poll' && poll.message.signals.some(s => s.type === 'poll' && s.options.length === 3));
const voted = await new Promise(res => r.emit('poll:vote', { messageId: poll.message.id, opt: 1 }, res));
ok('poll: vote counted', voted?.ok && voted.votes.total === 1 && voted.votes.counts[1] === 1);
const revoted = await new Promise(res => r.emit('poll:vote', { messageId: poll.message.id, opt: 0 }, res));
ok('poll: changing vote replaces, not duplicates', revoted?.votes.total === 1 && revoted.votes.counts[0] === 1);

// mention in the space chat (rahul mentions aarav)
const spaceConvo = (await authed(tokA, '/spaces/1')).conversation_id;
const mentionEvt = new Promise(res => a.once('inbox:update', d => res(d)));
r.emit('conversation:join', spaceConvo);
await new Promise(res => setTimeout(res, 100));
r.emit('message:send', { conversationId: spaceConvo, body: 'hey @aarav check the deck' });
const mEvt = await Promise.race([mentionEvt, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('mention: @aarav flagged in nudge', mEvt?.mentioned === true);

// call signaling relay
const callSeen = new Promise(res => a.once('call:signal', d => res(d)));
r.emit('call:signal', { to: 1, data: { type: 'offer', sdp: { type: 'offer', sdp: 'x' }, media: 'audio' } });
const callEvt = await Promise.race([callSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('calls: offer relayed with caller identity', callEvt?.from === 2 && callEvt.fromName === 'Rahul Verma' && callEvt.data.type === 'offer');
a.emit('call:signal', { to: 2, data: { type: 'end' } }); // hang up politely

// moments: post → visible to friend → view → scope respected
const story = await authed(tokA, '/stories', { body: { kind: 'text', body: 'shipping day', scope: 'all' } });
ok('moments: posted with 24h expiry', story.expires_at - story.created_at === 24 * 3600_000);
const rStories = await authed(tokR, '/stories');
const aGroup = rStories.groups.find(g => g.user_id === 1);
ok('moments: friend sees it, unseen ring on', !!aGroup && aGroup.allSeen === false);
await authed(tokR, '/stories/' + story.id + '/view', { body: {} });
const aStories = await authed(tokA, '/stories');
ok('moments: view counted for owner', aStories.groups.find(g => g.user_id === 1)?.stories.find(s => s.id === story.id)?.views === 1);
const innerStory = await authed(tokM, '/stories', { body: { kind: 'text', body: 'inner only', scope: 'inner' } });
const rSees = await authed(tokR, '/stories'); // rahul is maya's regular friend (closeness 2)
ok('moments: inner-circle scope enforced', !rSees.groups.find(g => g.user_id === 3)?.stories.some(s => s.id === innerStory.id));

// email login (google-born accounts use email; verify the path with a seeded email)
ok('email login: rejects unknown email cleanly', !!(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nobody@nowhere.io', password: 'x' }) }).then(x => x.json())).error);

// 4.4) Fun layer: streaks, effects, Friendship Wrapped
const ppl = await authed(tokA, '/people');
const rahulP = ppl.people.find(p => p.username === 'rahul');
ok('streak: computed for rahul (' + rahulP?.streak + 'd)', rahulP?.streak >= 2);

const fxSeen = new Promise(res => a.once('message:new', d => res(d)));
r.emit('message:send', { conversationId: 1, body: 'we got into the incubator!!', effect: 'confetti' });
const fxEvt = await Promise.race([fxSeen, new Promise(res => setTimeout(() => res(null), 1500))]);
ok('effect: confetti signal delivered', fxEvt?.message?.signals?.some(s => s.type === 'effect' && s.kind === 'confetti'));

const wrapped = await authed(tokA, '/people/2/wrapped');
ok('wrapped: stats computed', wrapped.total > 5 && typeof wrapped.myGhost === 'string' && wrapped.since > 0);
ok('wrapped: opener + peak hour present', (wrapped.iOpened + wrapped.theyOpened) > 0 && typeof wrapped.peakHour === 'number');

// 4.5) The Worlds: EDU (mastery + gap detector), LIFE (habits + rooms), HORIZON
const edu = await authed(tokA, '/edu/universe');
ok('edu: universe has concepts+links', edu.concepts?.length > 0 && edu.links?.length > 0);
// Deterministic gap: a fresh dependent with a weak prerequisite underneath
const gapDep = await authed(tokA, '/edu/concepts', { body: { name: 'Gap Dependent', emoji: 'sigma' } });
const gapPre = await authed(tokA, '/edu/concepts', { body: { name: 'Gap Prereq', emoji: 'limit', prereqOf: gapDep.id } });
const eduGap = await authed(tokA, '/edu/universe');
ok('edu: gap detector fires (weak prereq under active concept)',
  eduGap.gaps?.some(g => g.prereq.id === gapPre.id && g.dependent.id === gapDep.id));
ok('edu: study plan generated', eduGap.plan?.length >= 2);
await authed(tokA, '/edu/concepts/' + gapPre.id, { method: 'DELETE' });
await authed(tokA, '/edu/concepts/' + gapDep.id, { method: 'DELETE' });
const limits = edu.concepts.find(c => c.name === 'Limits');
const studied = await authed(tokA, `/edu/concepts/${limits.id}/study`, { body: { quality: 3 } });
ok('edu: studying brightens the planet', studied.effective > limits.effective);

const life = await authed(tokA, '/life');
ok('life: 10 rooms with items + habits', life.rooms?.length === 10 && life.items?.length > 0 && life.habits?.length > 0);
ok('life: health + travel rooms exist', ['health', 'travel'].every(k => life.rooms.some(rm => rm.key === k)));
const habit = life.habits.find(h => h.name === 'No sugar');
const done = await authed(tokA, `/life/habits/${habit.id}/done`, { body: {} });
ok('life: habit done keeps the streak alive', done.streak >= 1 && done.streak >= habit.streak);
const item = await authed(tokA, '/life/items', { body: { room: 'kitchen', title: 'test rice', dueAt: Date.now() + 3600_000 } });
ok('life: item created with due date', !!item.id && !!item.due_at);
await authed(tokA, '/life/items/' + item.id, { method: 'DELETE' });

// An open promise must exist for the horizon to show a comet — make one honestly
await authed(tokA, '/conversations/1/messages', { body: { body: "I'll send you the horizon test deck by Friday" } });
const hz = await authed(tokA, '/horizon');
const types = new Set((hz.nodes || []).map(n => n.type));
ok('horizon: universe spans people+concepts+spaces+memories+promises',
  ['person', 'concept', 'space', 'memory', 'promise'].every(t => types.has(t)));

const brief = await authed(tokA, '/briefing');
ok('briefing: includes life dues + fading knowledge', Array.isArray(brief.lifeDue) && Array.isArray(brief.reviewConcepts) && brief.reviewConcepts.length > 0);

// 4.7) Exam Simulator + Learning DNA + Crisis Predictor
const exam = await authed(tokA, '/edu/exam');
ok('exam: questions generated with risk notes', exam.questions?.length >= 3 && exam.questions.some(q => q.risk));
ok('exam: retention forecast present', Array.isArray(exam.forecast));
const examTargets = exam.questions.slice(0, 2);
const submitted = await authed(tokA, '/edu/exam/submit', {
  body: { results: [
    { conceptId: examTargets[0].concept_id, outcome: 'nailed', tookMs: 9000 },
    { conceptId: examTargets[1].concept_id, outcome: 'blank', tookMs: 30000 },
  ] },
});
ok('exam: nailed raises mastery', submitted.report[0].after > submitted.report[0].before);
ok('exam: blank corrects the record down', submitted.report[1].after <= submitted.report[1].before);

const dna = await authed(tokA, '/edu/dna');
ok('learning DNA computed with style: ' + dna.style, dna.sessions >= 2 && typeof dna.styleNote === 'string');

const insights = await authed(tokA, '/life/insights');
ok('crisis predictor emits warnings', Array.isArray(insights.warnings) && insights.warnings.length > 0);
ok('crisis warnings carry advice + severity', insights.warnings.every(w => w.advice && ['critical', 'warn', 'info'].includes(w.severity)));

// 5) AI summary (heuristic fallback or Ollama, whichever this machine has)
const sum = await authed(tokA, '/conversations/1/summary');
ok('summary generated (' + (sum.engine || '?') + ')', typeof sum.text === 'string' && sum.text.length > 20);
const status = await authed(tokA, '/ai/status');
ok('ai status reports local engine', status.local === true);

// ============================================================================
// 6) Missing-items build-out — Phases 6–12 (pins/roles/files, group calls,
//    moment kinds, notifications + push, context search, EDU & LIFE additions)
// ============================================================================
const timeout = ms => new Promise(res => setTimeout(() => res(null), ms));
const rahulId = (await authed(tokA, '/users/search?q=rahul')).users.find(u => u.username === 'rahul').id;

// -- Phase 6: pinned messages + shared files ---------------------------------
const pinMsg = (await authed(tokA, '/conversations/1/messages', { body: { body: 'pin me: the plan lives here' } })).message;
const pinRes = await authed(tokA, `/messages/${pinMsg.id}/pin`, { body: {} });
ok('pin: message pinned', pinRes.pinned === true);
const pinsList = await authed(tokR, '/conversations/1/pins');
ok('pin: strip lists it for the other side', pinsList.pins?.some(p => p.message_id === pinMsg.id));
const unpin = await authed(tokA, `/messages/${pinMsg.id}/pin`, { body: {} });
ok('pin: toggling unpins', unpin.pinned === false);
const files = await authed(tokA, '/conversations/1/files');
ok('files: shared media wall lists attachments', files.files?.length >= 1 && files.files.every(f => f.attachment?.url));

// -- Phase 6: space admins & permissions --------------------------------------
const sp6 = await authed(tokA, '/spaces', { body: { name: 'phase6-perms', emoji: 'rocket' } });
await authed(tokA, `/spaces/${sp6.id}/members`, { body: { username: 'rahul' } });
const denied = await fetch(BASE + `/api/spaces/${sp6.id}/members`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokR },
  body: JSON.stringify({ username: 'maya' }),
});
ok('roles: plain member cannot invite (403)', denied.status === 403);
await authed(tokA, `/spaces/${sp6.id}/members/${rahulId}`, { method: 'PATCH', body: { role: 'admin' } });
const nowAllowed = await authed(tokR, `/spaces/${sp6.id}/members`, { body: { username: 'maya' } });
ok('roles: promoted admin can invite', nowAllowed.ok === true);
const mayaId = (await authed(tokA, '/users/search?q=maya')).users.find(u => u.username === 'maya').id;
const kicked = await authed(tokR, `/spaces/${sp6.id}/members/${mayaId}`, { method: 'DELETE' })
  .catch(() => null); // admin removes a plain member (maya)
ok('roles: admin can remove a member', kicked?.ok === true);

// -- Phase 7: group calls (mesh relay) ----------------------------------------
const sp6d = await authed(tokA, '/spaces/' + sp6.id);
r.emit('conversation:join', sp6d.conversation_id);
await timeout(150);
const statePromise = new Promise(res => r.once('call:room:state', res));
const joinA = await new Promise(res => a.emit('call:room:join', { conversationId: sp6d.conversation_id, media: 'audio' }, res));
ok('group call: first joiner sees an empty room', joinA?.ok === true && joinA.peers.length === 0);
const st = await Promise.race([statePromise, timeout(1500)]);
ok('group call: live head-count reaches the space', st?.count === 1);
const peerJoinedP = new Promise(res => a.once('call:room:peer-joined', res));
const joinR = await new Promise(res => r.emit('call:room:join', { conversationId: sp6d.conversation_id, media: 'audio' }, res));
ok('group call: newcomer receives the existing peers', joinR?.ok === true && joinR.peers.length === 1 && joinR.peers[0].userId === 1);
const pj = await Promise.race([peerJoinedP, timeout(1500)]);
ok('group call: peer-joined announced to the room', pj?.userId === rahulId);
const gsigP = new Promise(res => a.once('call:room:signal', res));
r.emit('call:room:signal', { conversationId: sp6d.conversation_id, to: 1, data: { type: 'offer', sdp: 'test-sdp' } });
const gsg = await Promise.race([gsigP, timeout(1500)]);
ok('group call: handshake relayed peer-to-peer', gsg?.from === rahulId && gsg.data?.type === 'offer');
const leftP = new Promise(res => a.once('call:room:peer-left', res));
r.emit('call:room:leave', { conversationId: sp6d.conversation_id });
const lf = await Promise.race([leftP, timeout(1500)]);
ok('group call: leaving is announced', lf?.userId === rahulId);
a.emit('call:room:leave', { conversationId: sp6d.conversation_id });

// -- Phase 8: moment kinds (video / voice / music) ------------------------------
const vidUp = await authed(tokA, '/upload', { body: { name: 'clip.mp4', type: 'video/mp4', dataBase64: png1x1 } });
const vStory = await authed(tokA, '/stories', { body: { kind: 'video', attachment: vidUp, body: 'video moment' } });
ok('moments: video kind accepted', vStory.kind === 'video');
const musUp = await authed(tokA, '/upload', { body: { name: 'song.mp3', type: 'audio/mpeg', dataBase64: png1x1 } });
const mStory = await authed(tokA, '/stories', { body: { kind: 'music', attachment: musUp, body: 'song of the day' } });
ok('moments: music kind accepted', mStory.kind === 'music');
const badStory = await fetch(BASE + '/api/stories', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokA },
  body: JSON.stringify({ kind: 'video', body: 'no file' }),
});
ok('moments: media kinds demand an upload (400)', badStory.status === 400);

// -- Phase 9: notification center + web push -----------------------------------
await new Promise(res => r.emit('reaction:toggle', { messageId: pinMsg.id, kind: 'love' }, res));
await timeout(200);
const notifA = await authed(tokA, '/notifications');
ok('notify: reaction recorded for the author', notifA.notifications?.some(n => n.kind === 'reaction'));
await new Promise(res => a.emit('message:send', { conversationId: sp6d.conversation_id, body: 'hey @rahul look at this' }, res));
await timeout(200);
const notifR = await authed(tokR, '/notifications');
ok('notify: mention lands in the center', notifR.notifications?.some(n => n.kind === 'mention'));
ok('notify: story posts reach the circle', notifR.notifications?.some(n => n.kind === 'story'));
await authed(tokR, '/notifications/read', { body: {} });
const notifR2 = await authed(tokR, '/notifications');
ok('notify: mark-all-read zeroes the count', notifR2.unread === 0);
const pushKey = await authed(tokA, '/push/key');
ok('push: VAPID public key served', typeof pushKey.key === 'string' && pushKey.key.length > 80);
const subRes = await authed(tokA, '/push/subscribe', {
  body: { subscription: { endpoint: 'https://push.example.invalid/reg/abc123', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } },
});
ok('push: subscription stored', subRes.ok === true);
await authed(tokA, '/push/subscribe', { method: 'DELETE', body: { endpoint: 'https://push.example.invalid/reg/abc123' } });

// -- Phase 10: context search ----------------------------------------------------
const kindSearch = await authed(tokA, '/search?q=incubator&kind=message');
ok('search: kind lens returns only messages', kindSearch.results?.length > 0 && kindSearch.results.every(x => x.kind === 'message'));
const inSearch = await authed(tokA, '/search?q=incubator&in=1');
ok('search: in-chat lens scopes to one conversation', inSearch.results?.length > 0 && inSearch.results.every(x => x.conversation_id === 1));

// -- Phase 11: assignments, flash cards, study rooms ------------------------------
const tconcept = await authed(tokA, '/edu/concepts', { body: { name: 'Test Integrals', emoji: 'sigma' } });
const asg = await authed(tokA, '/edu/assignments', { body: { title: 'Problem set 3', conceptId: tconcept.id, dueAt: Date.now() + 24 * 3600_000 } });
ok('edu: assignment created with deadline', !!asg.id && asg.due_at > Date.now());
const briefAsg = await authed(tokA, '/briefing');
ok('edu: assignment surfaces in the briefing', briefAsg.assignmentsDue?.some(x => x.id === asg.id));
const card = await authed(tokA, '/edu/flashcards', { body: { conceptId: tconcept.id, front: 'What is an integral?', back: 'Accumulated change — area under the curve' } });
ok('edu: flash card created', !!card.id);
const review = await authed(tokA, '/edu/flashcards/review');
ok('edu: review session deals the card', review.cards?.some(c => c.id === card.id));
const graded = await authed(tokA, `/edu/flashcards/${card.id}/grade`, { body: { quality: 3 } });
ok('edu: grading a card brightens its planet', graded.ok === true && graded.concept.effective > 10);
const sroom = await authed(tokA, '/spaces', { body: { name: 'Calc crew', emoji: 'book', kind: 'study' } });
const srooms = await authed(tokA, '/edu/rooms');
ok('edu: study room listed in the EDU world', srooms.rooms?.some(x => x.id === sroom.id));
const noteItem = await authed(tokA, `/spaces/${sroom.id}/items`, { body: { type: 'note', title: 'chain rule trick' } });
const qItem = await authed(tokA, `/spaces/${sroom.id}/items`, { body: { type: 'question', title: 'why does u-sub work?' } });
ok('edu: study rooms hold notes & questions', !!noteItem.id && !!qItem.id);
await authed(tokA, '/edu/concepts/' + tconcept.id, { method: 'DELETE' }); // cascades card; keeps reruns stable

// -- Phase 12: goals ---------------------------------------------------------------
const goal = await authed(tokA, '/life/goals', { body: { title: 'test goal: run 5k', dueAt: Date.now() + 3 * 86_400_000 } });
ok('life: goal created at 0%', !!goal.id && goal.progress === 0);
const g60 = await authed(tokA, '/life/goals/' + goal.id, { method: 'PATCH', body: { progress: 60 } });
ok('life: progress moves honestly', g60.progress === 60 && g60.status === 'open');
const insights2 = await authed(tokA, '/life/insights');
ok('life: crisis predictor watches drifting goals', insights2.warnings?.some(w => w.title.includes('run 5k')));
const g100 = await authed(tokA, '/life/goals/' + goal.id, { method: 'PATCH', body: { progress: 100 } });
ok('life: 100% closes the goal', g100.status === 'done');
await authed(tokA, '/life/goals/' + goal.id, { method: 'DELETE' });
const hlItem = await authed(tokA, '/life/items', { body: { room: 'health', title: 'dentist checkup', dueAt: Date.now() + 3600_000 } });
ok('life: health room takes items', !!hlItem.id);
await authed(tokA, '/life/items/' + hlItem.id, { method: 'DELETE' });

// -- The vibes layer: Vibe Check Streak · MoodSync · Roast · Replay · Rizz ----------
// 1) Vibe Check Streak: only days where BOTH sent voice/video count
const fakeAudio = Buffer.from('vibe-check-bytes').toString('base64');
const vA = await authed(tokA, '/upload', { body: { name: 'vibe.webm', type: 'audio/webm', dataBase64: fakeAudio } });
const vR = await authed(tokR, '/upload', { body: { name: 'vibe.webm', type: 'audio/webm', dataBase64: fakeAudio } });
await authed(tokA, '/conversations/1/messages', { body: { body: '', attachment: vA } });
await authed(tokR, '/conversations/1/messages', { body: { body: '', attachment: vR } });
await authed(tokA, '/conversations/2/messages', { body: { body: 'dry text day with maya' } }); // aarav: text only in convo 2
const vM = await authed(tokM, '/upload', { body: { name: 'vibe.webm', type: 'audio/webm', dataBase64: fakeAudio } });
await authed(tokM, '/conversations/2/messages', { body: { body: '', attachment: vM } });
const vibePeople = await authed(tokA, '/people');
ok('vibe streak: both sent voice today → alive', vibePeople.people.find(p => p.username === 'rahul').vibe_streak >= 1);
ok('vibe streak: dry text does not count', vibePeople.people.find(p => p.username === 'maya').vibe_streak === 0);
ok('vibe streak: surfaces in wrapped', typeof (await authed(tokA, '/people/2/wrapped')).vibeStreak === 'number');

// 2) MoodSync Rooms: matching moods → temporary space → 6h → memory capsule
const soloMood = await authed(tokA, '/me/mood', { method: 'PATCH', body: { mood: 'unsure' } });
ok('moodsync: one person alone makes no room', soloMood.moodsync === null);
const duoMood = await authed(tokR, '/me/mood', { method: 'PATCH', body: { mood: 'unsure' } });
ok('moodsync: matching mood births a room', !!duoMood.moodsync?.id && !!duoMood.moodsync.conversation_id);
ok('moodsync: expires ~6h out', duoMood.moodsync.expires_at > Date.now() + 5 * 3600_000);
const msSent = await authed(tokA, `/conversations/${duoMood.moodsync.conversation_id}/messages`, { body: { body: 'we are all a little unsure in here' } });
ok('moodsync: members can chat', !!msSent.message?.id);
// force expiry (test-only), then any /spaces read dissolves it into capsules
const { DatabaseSync } = await import('node:sqlite');
const rawDb = new DatabaseSync(new URL('../data/aether.db', import.meta.url).pathname.replace(/^\//, ''));
rawDb.exec('PRAGMA busy_timeout = 5000;');
rawDb.prepare('UPDATE spaces SET expires_at=? WHERE id=?').run(Date.now() - 1000, duoMood.moodsync.id);
rawDb.close();
const afterSweep = await authed(tokA, '/spaces');
ok('moodsync: expired room dissolves out of /spaces', !afterSweep.spaces.some(s => s.id === duoMood.moodsync.id));
const capsules = await authed(tokA, '/memories');
ok('moodsync: memory capsule left behind', capsules.memories.some(m => m.body.startsWith('MoodSync capsule') && m.body.includes(duoMood.moodsync.name)));
await authed(tokA, '/me/mood', { method: 'PATCH', body: { mood: null } });      // restore seeded moods
await authed(tokR, '/me/mood', { method: 'PATCH', body: { mood: 'hyped' } });

// 3) Roast My Life: anonymous replies, Save Me ends it
const mySpaces = await authed(tokA, '/spaces');
let arena = mySpaces.spaces.find(s => s.name === 'Roast Test Arena');
if (!arena) {
  arena = await authed(tokA, '/spaces', { body: { name: 'Roast Test Arena', emoji: 'flame' } });
  await authed(tokA, `/spaces/${arena.id}/members`, { body: { username: 'rahul' } });
}
const roast = await authed(tokA, `/spaces/${arena.id}/roasts`, { body: { body: 'I wave back at people waving behind me' } });
ok('roast: created live', roast.id && roast.status === 'live');
const roastRep = await authed(tokR, `/roasts/${roast.id}/replies`, { body: { body: 'main character syndrome with an NPC storyline' } });
ok('roast: replies come back anonymized', roastRep.replies?.[0]?.alias?.startsWith('Anonymous Hater') && !JSON.stringify(roastRep.replies).includes('user_id'));
ok('roast: outsiders blocked', !!(await authed(tokM, `/roasts/${roast.id}`)).error);
ok('roast: only the roastee can Save Me', !!(await authed(tokR, `/roasts/${roast.id}/save`, { body: {} })).error);
ok('roast: Save Me ends it', (await authed(tokA, `/roasts/${roast.id}/save`, { body: {} })).status === 'saved');
ok('roast: no piling on after the save', !!(await authed(tokR, `/roasts/${roast.id}/replies`, { body: { body: 'one more—' } })).error);
await authed(tokA, `/roasts/${roast.id}`, { method: 'DELETE' }); // keep reruns tidy

// 4) Memory Vibe Replay: curated slides, sealed stays sealed
const replay = await authed(tokA, '/people/2/replay');
ok('replay: slides intro → outro', replay.slides?.[0]?.kind === 'intro' && replay.slides.at(-1).kind === 'outro');
ok('replay: carries stats and at least one moment', replay.slides.some(s => s.kind === 'stat') && replay.slides.some(s => s.kind === 'moment'));
ok('replay: ciphertext never becomes a moment', !replay.slides.some(s => s.kind === 'moment' && s.body.includes('"iv"')));

// 5) Rizz Battle: masked lines, honest judge, 24h crown
const rb = (await authed(tokA, '/rizz', { body: { otherId: 2 } })).battle;
ok('rizz: battle opens with a scenario', !!rb?.id && rb.status === 'active');
await authed(tokA, `/rizz/${rb.id}/line`, { body: { line: 'okay but was that post for the gains or for me — asking for my heart… 😌' } });
const rbTheirs = (await authed(tokR, '/rizz')).battles.find(b => b.id === rb.id);
ok('rizz: lines stay masked until the verdict', rbTheirs.their_submitted === true && rbTheirs.their_line === null);
const rbDone = (await authed(tokR, `/rizz/${rb.id}/line`, { body: { line: 'hey wyd' } })).battle;
ok('rizz: judged with an honest engine label', rbDone.status === 'judged' && /^(heuristic|ollama:)/.test(rbDone.engine) && !!rbDone.verdict);
ok('rizz: effort beats "hey wyd"', rbDone.winner_id === 1);
ok('rizz: winner crowned in /people', (await authed(tokR, '/people')).people.find(p => p.username === 'aarav').rizz_king === true);

console.log('\n=== SOCKET INTEGRATION RESULTS ===');
let pass = 0;
for (const [name, good] of results) { console.log((good ? 'PASS' : 'FAIL') + '  ' + name); if (good) pass++; }
console.log(`${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
