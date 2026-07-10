// ============================================================================
// IKVIZZ — The vibes layer: MoodSync Rooms, Roast My Life, Memory Vibe
// Replay, Rizz Battle. All local-first, all free-tier, zero new dependencies.
//
// MoodSync Rooms: set your mood blob and IKVIZZ quietly groups you with
// everyone else feeling the same thing — a temporary Living Space with a name
// like "Delulu Hours" or "Late Night Sad Bois". Six hours later the room
// dissolves and each member keeps a memory capsule instead of a chat backlog.
// ============================================================================
import { Router } from 'express';
import { db, now, ftsIndex, getOrCreateDm } from './db.js';
import { httpErr } from './auth.js';
import { MOOD_TAGS, getRelationship, chatStreak, vibeStreak } from './core.js';
import { mirror } from './cloud.js';
import { notify } from './notify.js';
import { judgeRizz } from './ai.js';

export const vibes = Router();

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' }); }
};

/** Space you can actually see: exists, not dissolved, and you're a member. */
function requireSpaceMember(req, spaceId) {
  const space = db.prepare(`SELECT * FROM spaces WHERE id=? AND dissolved_at IS NULL`).get(Number(spaceId));
  const member = space && db.prepare(`SELECT 1 FROM space_members WHERE space_id=? AND user_id=?`).get(space.id, req.userId);
  if (!member) throw httpErr(404, 'Space not found.');
  return space;
}

// ------------------------------------------------------------ MoodSync -----
const ROOM_TTL = 6 * 3600_000;

// Names carry the mood; late night gets its own energy.
const ROOM_NAMES = {
  joy:     ['Serotonin HQ', 'Main Character Hours'],
  love:    ['Down Bad Central', 'Hopeless Romantics Club'],
  hyped:   ['Delulu Hours', 'Unhinged & Thriving'],
  jk:      ['Clown Council', 'Certified Yappers Lounge'],
  unsure:  ['Overthinkers Anonymous', 'The Question Mark Era'],
  serious: ['Lock-In Chat', 'Grind Mode HQ'],
  down:    ['Sad Bois Club', 'Crying Together Rn'],
  blown:   ['Mind = Blown HQ', 'The Cooked Collective'],
};
const ROOM_ICONS = { joy: 'sun', love: 'heart', hyped: 'zap', jk: 'smile', unsure: 'help', serious: 'target', down: 'moon', blown: 'comet' };

function roomName(mood) {
  const hour = new Date().getHours();
  const lateNight = hour >= 22 || hour < 5;
  if (mood === 'down' && lateNight) return 'Late Night Sad Bois';
  const pool = ROOM_NAMES[mood] || ['The Vibe Room'];
  // Alternate names so back-to-back rooms don't all read the same
  const born = db.prepare(`SELECT COUNT(*) AS c FROM spaces WHERE kind='moodsync' AND mood=?`).get(mood).c;
  return (lateNight ? 'Late Night ' : '') + pool[born % pool.length];
}

const activeRoom = mood => db.prepare(`
  SELECT * FROM spaces WHERE kind='moodsync' AND mood=? AND dissolved_at IS NULL AND expires_at > ?
`).get(mood, Date.now());

const roomConvo = spaceId => db.prepare(`SELECT * FROM conversations WHERE kind='space' AND space_id=?`).get(spaceId);

const roomSummary = space => space && {
  id: space.id, name: space.name, emoji: space.emoji, mood: space.mood,
  expires_at: space.expires_at, conversation_id: roomConvo(space.id)?.id,
};

/** The room's whole life, condensed into one memory per member. */
function dissolveMoodRoom(space) {
  const convo = roomConvo(space.id);
  const members = db.prepare(`
    SELECT sm.user_id, u.display_name FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE sm.space_id=?
  `).all(space.id);
  const msgs = convo ? db.prepare(`
    SELECT m.body, u.display_name FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.conversation_id=? AND m.deleted=0 AND m.kind != 'sealed' AND m.body != ''
    ORDER BY m.id DESC LIMIT 3
  `).all(convo.id).reverse() : [];
  const total = convo ? db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=? AND deleted=0`).get(convo.id).c : 0;

  const names = members.map(m => m.display_name.split(' ')[0]).join(', ');
  const capsule = `MoodSync capsule — "${space.name}" (${space.mood}): ${members.length} souls, ${total} message${total === 1 ? '' : 's'}, six hours of shared vibes with ${names}.`;
  const note = msgs.map(m => `${m.display_name.split(' ')[0]}: ${m.body.slice(0, 90)}`).join('\n');

  for (const m of members) {
    const r = db.prepare(`INSERT INTO memories (user_id, message_id, body, note, created_at) VALUES (?,NULL,?,?,?)`)
      .run(m.user_id, capsule, note, now());
    ftsIndex('memory', r.lastInsertRowid, m.user_id, capsule + ' ' + note);
    notify(m.user_id, 'moodsync', `"${space.name}" dissolved`, 'The room is gone — the memory capsule is yours to keep.', {});
  }
  // The space stops existing for everyone; rows stay for the cloud's sake.
  db.prepare(`DELETE FROM space_members WHERE space_id=?`).run(space.id);
  db.prepare(`UPDATE spaces SET dissolved_at=? WHERE id=?`).run(now(), space.id);
  if (convo) mirror.chat(convo.id);
}

export function sweepMoodRooms() {
  const due = db.prepare(`
    SELECT * FROM spaces WHERE kind='moodsync' AND dissolved_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?
  `).all(Date.now());
  for (const room of due) dissolveMoodRoom(room);
  return due.length;
}
setInterval(sweepMoodRooms, 60_000).unref(); // lazy sweeps on reads still apply

/**
 * Called when a user sets their mood. Joins (or births) the room for that
 * mood — a room only forms once at least two people share the feeling.
 * Changing your mood later doesn't eject you: the vibe was real when it synced.
 */
export function syncMood(userId, mood) {
  if (!MOOD_TAGS.includes(mood)) return null;
  sweepMoodRooms();
  const me = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(userId);

  const existing = activeRoom(mood);
  if (existing) {
    const already = db.prepare(`SELECT 1 FROM space_members WHERE space_id=? AND user_id=?`).get(existing.id, userId);
    if (!already) {
      db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES (?,?,'member')`).run(existing.id, userId);
      const convo = roomConvo(existing.id);
      if (convo) mirror.chat(convo.id);
      for (const m of db.prepare(`SELECT user_id FROM space_members WHERE space_id=? AND user_id!=?`).all(existing.id, userId)) {
        notify(m.user_id, 'moodsync', `${me.display_name} vibed into "${existing.name}"`, `everyone here is feeling ${mood}`, { conversationId: convo?.id });
      }
    }
    return roomSummary(existing);
  }

  // No room yet — is anyone else out there feeling this right now?
  const kin = db.prepare(`SELECT id, display_name FROM users WHERE mood=? AND id!=?`).all(mood, userId);
  if (!kin.length) return null;

  const name = roomName(mood);
  const r = db.prepare(`
    INSERT INTO spaces (name, emoji, description, owner_id, created_at, kind, mood, expires_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(name, ROOM_ICONS[mood] || 'zap', `Everyone in here is feeling ${mood}. Dissolves in 6 hours.`,
    userId, now(), 'moodsync', mood, now() + ROOM_TTL);
  const spaceId = Number(r.lastInsertRowid);
  const add = db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES (?,?,'member')`);
  add.run(spaceId, userId);
  for (const k of kin) add.run(spaceId, k.id);
  const convo = db.prepare(`INSERT INTO conversations (kind, space_id, created_at) VALUES ('space', ?, ?)`).run(spaceId, now());
  mirror.chat(Number(convo.lastInsertRowid));
  for (const k of kin) {
    notify(k.id, 'moodsync', `You've been synced into "${name}"`,
      `${kin.length + 1} people are feeling ${mood} right now — 6 hours, then it's a memory.`, { conversationId: Number(convo.lastInsertRowid) });
  }
  return roomSummary(db.prepare(`SELECT * FROM spaces WHERE id=?`).get(spaceId));
}

// ------------------------------------------------------- Roast My Life -----
// Submit a photo or a story to a space; replies come back anonymous — the
// server still knows who wrote what (anonymity is a costume, not a shield).
// The roastee holds the one true power: the "Save Me" button.

const roastRow = (r, viewerId) => ({
  id: r.id, space_id: r.space_id, status: r.status, created_at: r.created_at, saved_at: r.saved_at,
  body: r.body, attachment: r.attachment ? JSON.parse(r.attachment) : null,
  roastee: { id: r.user_id, display_name: r.display_name, avatar_hue: r.avatar_hue, avatar_url: r.avatar_url },
  replies: r.replies, mine: r.user_id === viewerId,
});

vibes.get('/spaces/:id/roasts', wrap((req, res) => {
  const space = requireSpaceMember(req, req.params.id);
  const roasts = db.prepare(`
    SELECT r.*, u.display_name, u.avatar_hue, u.avatar_url,
           (SELECT COUNT(*) FROM roast_replies WHERE roast_id=r.id) AS replies
    FROM roasts r JOIN users u ON u.id=r.user_id
    WHERE r.space_id=? ORDER BY r.status='live' DESC, r.created_at DESC LIMIT 30
  `).all(space.id).map(r => roastRow(r, req.userId));
  res.json({ roasts });
}));

vibes.post('/spaces/:id/roasts', wrap((req, res) => {
  const space = requireSpaceMember(req, req.params.id);
  const body = String(req.body?.body || '').trim().slice(0, 500);
  const attachment = req.body?.attachment;
  let att = null;
  if (attachment && typeof attachment === 'object') {
    if (!attachment.url?.startsWith('/files/') || attachment.url.includes('..')) throw httpErr(400, 'Upload the photo here first.');
    att = JSON.stringify({ url: attachment.url, name: String(attachment.name || ''), type: String(attachment.type || '') });
  }
  if (!body && !att) throw httpErr(400, 'Give them SOMETHING to work with — a photo or a story.');
  const r = db.prepare(`INSERT INTO roasts (space_id, user_id, body, attachment, created_at) VALUES (?,?,?,?,?)`)
    .run(space.id, req.userId, body, att, now());
  const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(req.userId);
  for (const m of db.prepare(`SELECT user_id FROM space_members WHERE space_id=? AND user_id!=?`).all(space.id, req.userId)) {
    notify(m.user_id, 'roast', `${me.display_name} volunteered for a roasting`,
      `"${(body || 'a photo').slice(0, 80)}" — replies are anonymous. Cook.`, { spaceId: space.id, roastId: Number(r.lastInsertRowid) });
  }
  const row = db.prepare(`
    SELECT r.*, u.display_name, u.avatar_hue, u.avatar_url, 0 AS replies
    FROM roasts r JOIN users u ON u.id=r.user_id WHERE r.id=?
  `).get(r.lastInsertRowid);
  res.json(roastRow(row, req.userId));
}));

function requireRoast(req) {
  const roast = db.prepare(`SELECT * FROM roasts WHERE id=?`).get(Number(req.params.id));
  if (!roast) throw httpErr(404, 'Roast not found.');
  requireSpaceMember(req, roast.space_id);
  return roast;
}

/** Stable anonymous aliases per roast: first distinct replier = Hater #1… */
function anonymizedReplies(roast, viewerId) {
  const rows = db.prepare(`SELECT * FROM roast_replies WHERE roast_id=? ORDER BY id ASC`).all(roast.id);
  const aliases = new Map();
  for (const r of rows) {
    if (r.user_id === roast.user_id) { aliases.set(r.user_id, 'The Roastee'); continue; }
    if (!aliases.has(r.user_id)) aliases.set(r.user_id, `Anonymous Hater #${aliases.size + (aliases.has(roast.user_id) ? 0 : 1)}`);
  }
  return rows.map(r => ({ id: r.id, body: r.body, created_at: r.created_at, alias: aliases.get(r.user_id), mine: r.user_id === viewerId }));
}

vibes.get('/roasts/:id', wrap((req, res) => {
  const roast = requireRoast(req);
  const row = db.prepare(`
    SELECT r.*, u.display_name, u.avatar_hue, u.avatar_url,
           (SELECT COUNT(*) FROM roast_replies WHERE roast_id=r.id) AS replies
    FROM roasts r JOIN users u ON u.id=r.user_id WHERE r.id=?
  `).get(roast.id);
  res.json({ roast: roastRow(row, req.userId), replies: anonymizedReplies(roast, req.userId) });
}));

vibes.post('/roasts/:id/replies', wrap((req, res) => {
  const roast = requireRoast(req);
  if (roast.status !== 'live') throw httpErr(400, 'The roastee pressed Save Me — this roast is over.');
  const body = String(req.body?.body || '').trim().slice(0, 280);
  if (!body) throw httpErr(400, 'A roast with no words is just staring.');
  db.prepare(`INSERT INTO roast_replies (roast_id, user_id, body, created_at) VALUES (?,?,?,?)`)
    .run(roast.id, req.userId, body, now());
  if (roast.user_id !== req.userId) {
    notify(roast.user_id, 'roast', 'The roast is cooking', body.slice(0, 140), { spaceId: roast.space_id, roastId: roast.id });
  }
  res.json({ replies: anonymizedReplies(roast, req.userId), status: roast.status });
}));

// The mercy button. Only the roastee can press it, and it ends everything.
vibes.post('/roasts/:id/save', wrap((req, res) => {
  const roast = requireRoast(req);
  if (roast.user_id !== req.userId) throw httpErr(403, 'Only the roastee can save themselves.');
  if (roast.status === 'live') {
    db.prepare(`UPDATE roasts SET status='saved', saved_at=? WHERE id=?`).run(now(), roast.id);
    const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(req.userId);
    for (const u of db.prepare(`SELECT DISTINCT user_id FROM roast_replies WHERE roast_id=? AND user_id!=?`).all(roast.id, req.userId)) {
      notify(u.user_id, 'roast', `${me.display_name} pressed Save Me`, 'The roast is over. Hope you got it out of your system.', { spaceId: roast.space_id, roastId: roast.id });
    }
  }
  res.json({ ok: true, status: 'saved' });
}));

vibes.delete('/roasts/:id', wrap((req, res) => {
  const roast = requireRoast(req);
  if (roast.user_id !== req.userId) throw httpErr(403, 'Only the roastee can take it down.');
  db.prepare(`DELETE FROM roasts WHERE id=?`).run(roast.id); // replies cascade
  res.json({ ok: true });
}));

// -------------------------------------------------- Memory Vibe Replay -----
// Friendship Wrapped, but as a reel: the server curates the best moments into
// ordered slides; the client animates them and renders a shareable poster.
// Computed locally from your own history — nothing leaves the machine.
const REPLAY_STOPWORDS = new Set('the a an and or but so to of in on at for with is are was were be been i you we they he she it this that my your our me him her them will would can could just not no yes ok okay do did done have has had what when where how why who'.split(' '));

vibes.get('/people/:otherId/replay', wrap((req, res) => {
  const otherId = Number(req.params.otherId);
  const other = db.prepare(`SELECT id, display_name, avatar_hue, avatar_url FROM users WHERE id=?`).get(otherId);
  if (!other || !getRelationship(req.userId, otherId)) throw httpErr(404, 'Not in your universe.');
  const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(req.userId);
  const convo = getOrCreateDm(req.userId, otherId);
  const msgs = db.prepare(`
    SELECT id, sender_id, body, created_at, kind, unlock_at FROM messages
    WHERE conversation_id=? AND deleted=0 ORDER BY id ASC
  `).all(convo.id);
  if (msgs.length < 5) return res.json({ tooEarly: true });

  const say = m => m.kind !== 'sealed' && (!m.unlock_at || m.unlock_at < Date.now()) && m.body;
  const name = id => (id === req.userId ? me.display_name : other.display_name).split(' ')[0];

  // The most-reacted lines are the moments worth replaying
  const topMoments = db.prepare(`
    SELECT m.id, m.body, m.sender_id, m.created_at, m.kind, m.unlock_at, COUNT(r.user_id) AS n
    FROM messages m JOIN reactions r ON r.message_id = m.id
    WHERE m.conversation_id=? AND m.deleted=0
    GROUP BY m.id ORDER BY n DESC, m.id DESC LIMIT 5
  `).all(convo.id).filter(say).slice(0, 3);

  const freq = {};
  for (const m of msgs.filter(say)) {
    for (const w of m.body.toLowerCase().split(/[^a-z']+/)) {
      if (w.length > 2 && !REPLAY_STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    }
  }
  const topWord = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const hours = msgs.map(m => new Date(m.created_at).getHours());
  const peakHour = [...new Set(hours)].sort((a, b) => hours.filter(h => h === b).length - hours.filter(h => h === a).length)[0];
  const mineCount = msgs.filter(m => m.sender_id === req.userId).length;
  const streak = chatStreak(convo.id, req.userId, otherId);
  const vibe = vibeStreak(convo.id, req.userId, otherId);
  const memories = db.prepare(`
    SELECT COUNT(*) AS c FROM memories WHERE user_id=? AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)
  `).get(req.userId, convo.id).c;
  const first = msgs.find(say);

  const slides = [
    { kind: 'intro', title: `you × ${other.display_name.split(' ')[0]}`, sub: `together since ${new Date(msgs[0].created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` },
    { kind: 'stat', big: String(msgs.length), label: 'messages', sub: `you ${Math.round((mineCount / msgs.length) * 100)}% · them ${100 - Math.round((mineCount / msgs.length) * 100)}%` },
  ];
  if (streak >= 2 || vibe >= 2) slides.push({
    kind: 'stat', big: (vibe >= 2 ? vibe : streak) + 'd',
    label: vibe >= 2 ? 'vibe check streak' : 'streak',
    sub: vibe >= 2 ? 'voice & video days only — certified not dry' : 'days you both showed up',
  });
  if (first) slides.push({ kind: 'moment', label: 'where it all started', from: name(first.sender_id), body: first.body.slice(0, 140), at: first.created_at });
  for (const m of topMoments) slides.push({ kind: 'moment', label: 'a certified moment', from: name(m.sender_id), body: m.body.slice(0, 140), at: m.created_at, reactions: m.n });
  if (topWord) slides.push({ kind: 'stat', big: `“${topWord}”`, label: 'your word of the era', sub: `peak chaos hour: ${peakHour}:00` });
  if (memories) slides.push({ kind: 'stat', big: String(memories), label: 'memories saved forever', sub: 'the brain keeps receipts' });
  slides.push({ kind: 'outro', title: 'the vibes were real', sub: 'IKVIZZ · Memory Vibe Replay' });

  res.json({ name: other.display_name, myName: me.display_name, slides, total: msgs.length, streak, vibeStreak: vibe, topWord });
}));

// ------------------------------------------------------------ Rizz Battle -----
// 1v1: same scenario, one line each, judged by local Ollama when present and
// an honest points heuristic otherwise. Winner is Rizz King for 24 hours.
const RIZZ_TTL = 24 * 3600_000;
const RIZZ_SCENARIOS = [
  'Your crush just posted a gym mirror selfie. Drop the opener.',
  "They left you on read for three days and just texted 'wyd'. Cook.",
  'Rizz up the barista who wrote the wrong name on your cup.',
  "Your situationship said 'we need to talk'. Turn it around.",
  'Shoot your shot with someone reading your favorite book on the train.',
  "It's 2am and they posted a sad story. Say something smooth but kind.",
  'Convince them pineapple pizza is a first-date idea.',
  'Their dog likes you more than it likes them. Capitalize.',
];

function battleView(b, viewerId) {
  const iAmChallenger = b.challenger_id === viewerId;
  const myLine = iAmChallenger ? b.challenger_line : b.opponent_line;
  const theirLine = iAmChallenger ? b.opponent_line : b.challenger_line;
  const named = id => db.prepare(`SELECT id, username, display_name, avatar_hue, avatar_url FROM users WHERE id=?`).get(id);
  return {
    id: b.id, scenario: b.scenario, status: b.status, created_at: b.created_at, judged_at: b.judged_at,
    challenger: named(b.challenger_id), opponent: named(b.opponent_id),
    my_line: myLine, my_turn: b.status === 'active' && !myLine,
    their_submitted: !!theirLine,
    // Never leak the other line before the verdict — no copying homework
    their_line: b.status === 'judged' ? theirLine : null,
    winner_id: b.winner_id, engine: b.engine, verdict: b.verdict,
    won: b.status === 'judged' && b.winner_id === viewerId,
  };
}

const activeBattle = (a, b) => db.prepare(`
  SELECT * FROM rizz_battles WHERE status='active'
  AND ((challenger_id=? AND opponent_id=?) OR (challenger_id=? AND opponent_id=?))
`).get(a, b, b, a);

vibes.get('/rizz', wrap((req, res) => {
  const battles = db.prepare(`
    SELECT * FROM rizz_battles WHERE challenger_id=? OR opponent_id=? ORDER BY id DESC LIMIT 20
  `).all(req.userId, req.userId).map(b => battleView(b, req.userId));
  res.json({ battles });
}));

vibes.post('/rizz', wrap((req, res) => {
  const otherId = Number(req.body?.otherId);
  const other = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(otherId);
  if (!other || !getRelationship(req.userId, otherId)) throw httpErr(404, 'Not in your universe.');
  if (otherId === req.userId) throw httpErr(400, 'You cannot out-rizz yourself. Philosophically.');
  const existing = activeBattle(req.userId, otherId);
  if (existing) return res.json({ battle: battleView(existing, req.userId), existing: true });
  const born = db.prepare(`SELECT COUNT(*) AS c FROM rizz_battles`).get().c;
  const scenario = RIZZ_SCENARIOS[born % RIZZ_SCENARIOS.length];
  const r = db.prepare(`INSERT INTO rizz_battles (challenger_id, opponent_id, scenario, created_at) VALUES (?,?,?,?)`)
    .run(req.userId, otherId, scenario, now());
  const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(req.userId);
  const convo = getOrCreateDm(req.userId, otherId);
  notify(otherId, 'rizz', `${me.display_name} challenged you to a Rizz Battle`, scenario, { conversationId: convo.id });
  res.json({ battle: battleView(db.prepare(`SELECT * FROM rizz_battles WHERE id=?`).get(r.lastInsertRowid), req.userId) });
}));

vibes.post('/rizz/:id/line', async (req, res) => {
  try {
    const b = db.prepare(`SELECT * FROM rizz_battles WHERE id=?`).get(Number(req.params.id));
    if (!b || (b.challenger_id !== req.userId && b.opponent_id !== req.userId)) throw httpErr(404, 'Battle not found.');
    if (b.status !== 'active') throw httpErr(400, 'This battle has been judged. Take the L or the W.');
    const col = b.challenger_id === req.userId ? 'challenger_line' : 'opponent_line';
    if (b[col]) throw httpErr(400, 'Your line is locked in. No take-backs in rizz.');
    const line = String(req.body?.line || '').trim().slice(0, 280);
    if (!line) throw httpErr(400, 'Silence is not rizz.');
    db.prepare(`UPDATE rizz_battles SET ${col}=? WHERE id=?`).run(line, b.id);

    const fresh = db.prepare(`SELECT * FROM rizz_battles WHERE id=?`).get(b.id);
    if (fresh.challenger_line && fresh.opponent_line) {
      // Both lines in — the judge takes it from here (challenger is A)
      const { engine, winner, verdict } = await judgeRizz(fresh.scenario, fresh.challenger_line, fresh.opponent_line);
      const winnerId = winner === 'A' ? fresh.challenger_id : fresh.opponent_id;
      const loserId = winner === 'A' ? fresh.opponent_id : fresh.challenger_id;
      db.prepare(`UPDATE rizz_battles SET status='judged', winner_id=?, engine=?, verdict=?, judged_at=? WHERE id=?`)
        .run(winnerId, engine, verdict, now(), fresh.id);
      db.prepare(`UPDATE users SET rizz_king_until=? WHERE id=?`).run(now() + RIZZ_TTL, winnerId);
      const kingName = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(winnerId).display_name;
      const convo = getOrCreateDm(fresh.challenger_id, fresh.opponent_id);
      notify(winnerId, 'rizz', 'You are the Rizz King', `24-hour reign starts now. Verdict: ${verdict.slice(0, 120)}`, { conversationId: convo.id });
      notify(loserId, 'rizz', `${kingName} out-rizzed you`, `Verdict: ${verdict.slice(0, 120)}`, { conversationId: convo.id });
    }
    res.json({ battle: battleView(db.prepare(`SELECT * FROM rizz_battles WHERE id=?`).get(b.id), req.userId) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' }); }
});
