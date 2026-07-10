// ============================================================================
// Ikvizz — Demo world seeder. Run once:  npm run seed
// Creates a small living universe so the product philosophy is visible the
// moment you sign in — promises, ideas, contexts, a startup space, memories.
//
// Sign in as:  aarav / aether123   (or any of: rahul, maya, amma, vikram)
// ============================================================================
import { db, now, getOrCreateDm, ftsIndex } from './db.js';
import { createUser } from './auth.js';
import { classifyPriority, detectSignals } from './brain.js';

const HOUR = 3600_000, DAY = 24 * HOUR;

if (db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c > 0) {
  console.log('Database already has users — skipping seed. Delete data/aether.db to reseed.');
  process.exit(0);
}

// ---------------------------------------------------------------- people ----
const mk = (username, displayName, phone) => createUser({ username, password: 'aether123', displayName, phone });
const aarav  = mk('aarav', 'Aarav Sharma', '+919876500001');
const rahul  = mk('rahul', 'Rahul Verma', '+919876500002');
const maya   = mk('maya', 'Maya Iyer', '+919876500003');
const amma   = mk('amma', 'Amma');
const vikram = mk('vikram', 'Vikram Rao', '+919876500005');
const dev    = mk('dev', 'Dev Menon', '+919876500006'); // the friend you're drifting from

// Mood canvas
db.prepare(`UPDATE users SET mood='hyped' WHERE id=?`).run(rahul.id);
db.prepare(`UPDATE users SET mood='serious' WHERE id=?`).run(maya.id);
db.prepare(`UPDATE users SET mood='joy' WHERE id=?`).run(amma.id);

// Live contexts (Context Engine demo)
db.prepare(`UPDATE users SET context='deepwork', context_note='Shipping the pitch deck', context_scope='all' WHERE id=?`).run(rahul.id);
db.prepare(`UPDATE users SET context='gym', context_scope='inner' WHERE id=?`).run(maya.id);
db.prepare(`UPDATE users SET context='sleeping', context_scope='inner' WHERE id=?`).run(amma.id);
db.prepare(`UPDATE users SET context='meeting', context_note='Board reviews all day', context_scope='all' WHERE id=?`).run(vikram.id);

// -------------------------------------------------- relationship graph -----
const rel = db.prepare(`INSERT INTO relationships (user_id, other_id, kind, closeness, persona_id, created_at) VALUES (?,?,?,?,?,?)`);
const personaOf = (uid, name) => db.prepare(`SELECT id FROM personas WHERE user_id=? AND name=?`).get(uid, name)?.id ?? null;

function connect(a, b, kindAB, closeAB, kindBA, closeBA, personaA = 'Personal', personaB = 'Personal') {
  rel.run(a.id, b.id, kindAB, closeAB, personaOf(a.id, personaA), now());
  rel.run(b.id, a.id, kindBA, closeBA, personaOf(b.id, personaB), now());
  getOrCreateDm(a.id, b.id);
}
connect(aarav, rahul,  'Close Friend', 1, 'Close Friend', 1);
connect(aarav, maya,   'Colleague',    2, 'Colleague',    2, 'Professional', 'Professional');
connect(aarav, amma,   'Family',       1, 'Family',       1);
connect(aarav, vikram, 'Investor',     3, 'Client',       3, 'Professional', 'Professional');
connect(rahul, maya,   'Friend',       2, 'Friend',       2);
connect(aarav, dev,    'Close Friend', 2, 'Close Friend', 2); // drifting…

// ------------------------------------------------------------- messages ----
function say(from, to, body, agoMs, opts = {}) {
  const convo = getOrCreateDm(from.id, to.id);
  const relRow = db.prepare(`SELECT closeness FROM relationships WHERE user_id=? AND other_id=?`).get(to.id, from.id);
  const priority = classifyPriority(body, relRow?.closeness ?? 2);
  const signals = detectSignals(body);
  const ts = now() - agoMs;
  const r = db.prepare(`INSERT INTO messages (conversation_id, sender_id, body, priority, signals, reply_to, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(convo.id, from.id, body, priority, JSON.stringify(signals), opts.replyTo || null, ts);
  const mid = Number(r.lastInsertRowid);
  ftsIndex('message', mid, convo.id, body);
  const promise = signals.find(s => s.type === 'promise');
  if (promise && !opts.noPromise) {
    db.prepare(`INSERT INTO promises (user_id, to_id, message_id, body, due_hint, created_at) VALUES (?,?,?,?,?,?)`)
      .run(from.id, to.id, mid, body, promise.due || '', ts);
    timeline(from.id, to.id, 'promise', body.slice(0, 120), ts);
  }
  if (signals.some(s => s.type === 'idea')) timeline(from.id, to.id, 'idea', body.slice(0, 120), ts);
  if (opts.read) {
    db.prepare(`INSERT INTO reads (conversation_id, user_id, last_read_id) VALUES (?,?,?)
                ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_id=excluded.last_read_id`)
      .run(convo.id, to.id, mid);
  }
  return mid;
}

function timeline(a, b, type, title, ts) {
  const t = db.prepare(`INSERT INTO timeline_events (user_id, other_id, type, title, created_at) VALUES (?,?,?,?,?)`);
  t.run(a, b, type, title, ts); t.run(b, a, type, title, ts);
}

timeline(aarav.id, rahul.id, 'first_message', 'First conversation', now() - 30 * DAY);
timeline(aarav.id, amma.id, 'milestone', 'Diwali together in Chennai 🪔', now() - 20 * DAY);

// Rahul ↔ Aarav — the startup thread (ideas + promises + replies + reactions)
const react = db.prepare(`INSERT INTO reactions (message_id, user_id, kind) VALUES (?,?,?)`);
const mWedge = say(rahul, aarav, 'Bro, what if we build the invoice tool for freelancers first and expand later? Small wedge, huge market.', 6 * DAY, { read: true });
react.run(mWedge, aarav.id, 'flame');
react.run(mWedge, aarav.id, 'bulb');
const mAuto = say(aarav, rahul, 'That is actually solid. What if we auto-link every invoice to the client conversation?', 6 * DAY - HOUR, { read: true, replyTo: mWedge });
react.run(mAuto, rahul.id, 'heart');
say(rahul, aarav, "I'll draft the one-pager by Friday and share it with you.", 3 * DAY, { read: true, replyTo: mAuto });
say(rahul, aarav, 'Also check this — https://example.com/yc-freelancer-tools — found this thread on freelancer pain points.', 2 * DAY, { read: true });
// A living 3-day streak: both sides show up every day
say(aarav, rahul, 'Read the whole thread. Freelancers it is.', 2 * DAY - 2 * HOUR, { read: true });
say(rahul, aarav, 'Also we need a name that does not sound like a crypto scam.', 26 * HOUR, { read: true });
say(aarav, rahul, 'High bar. Let us see.', 25 * HOUR, { read: true });
say(rahul, aarav, 'Deadline for the incubator application is due this week. Can you confirm the company name today?', 5 * HOUR);
say(aarav, rahul, 'On it. Shortlist tonight.', 4 * HOUR, { read: true });

// Maya ↔ Aarav — work thread
say(maya, aarav, 'Meeting moved to 3pm tomorrow. Can you approve the design doc before that?', 7 * HOUR);
say(aarav, maya, "I'll review it tonight and send comments.", 6 * HOUR, { read: true });

// Amma ↔ Aarav — family warmth
say(amma, aarav, 'Did you eat properly today?', 26 * HOUR, { read: true });
say(aarav, amma, "Yes amma 😄 I'll call you this weekend, promise.", 25 * HOUR, { read: true });
say(amma, aarav, 'Take your vitamins. And come home for your cousin’s wedding next month!', 9 * HOUR);

// Dev ↔ Aarav — the friendship that's quietly drifting (45 days of silence)
say(dev, aarav, 'That trek was legendary man. Same time next year?', 46 * DAY, { read: true });
say(aarav, dev, 'Booked. No excuses.', 45 * DAY, { read: true, noPromise: true });

// Vikram ↔ Aarav — investor thread
say(vikram, aarav, 'Interesting deck. Send the financial projections by Monday — urgent, partner meeting is Tuesday.', 30 * HOUR);
say(aarav, vikram, "Understood. I will send the projections by Monday morning.", 29 * HOUR, { read: true });

// ------------------------------------------------------------- memories ----
function remember(user, text, note, agoMs) {
  const r = db.prepare(`INSERT INTO memories (user_id, message_id, body, note, created_at) VALUES (?,?,?,?,?)`)
    .run(user.id, null, text, note, now() - agoMs);
  ftsIndex('memory', r.lastInsertRowid, user.id, text + ' ' + note);
}
remember(aarav, 'Rahul suggested starting with the freelancer invoice wedge before Diwali.', 'The startup idea', 6 * DAY);
remember(aarav, "Amma's knee checkup is on the 15th — book the cab.", 'Family', 4 * DAY);
remember(aarav, 'Vikram cares most about unit economics, not vision slides.', 'Investor prep', 30 * HOUR);

// ---------------------------------------------------------- living space ----
const sp = db.prepare(`INSERT INTO spaces (name, emoji, description, owner_id, created_at) VALUES (?,?,?,?,?)`)
  .run('Startup', 'rocket', 'The freelancer-invoice wedge. Ship small, learn fast.', aarav.id, now() - 6 * DAY);
const spaceId = Number(sp.lastInsertRowid);
const addMember = db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES (?,?,?)`);
addMember.run(spaceId, aarav.id, 'owner');
addMember.run(spaceId, rahul.id, 'member');
addMember.run(spaceId, maya.id, 'member');
db.prepare(`INSERT INTO conversations (kind, space_id, created_at) VALUES ('space', ?, ?)`).run(spaceId, now() - 6 * DAY);

const item = db.prepare(`INSERT INTO space_items (space_id, type, title, body, status, creator_id, created_at) VALUES (?,?,?,?,?,?,?)`);
const spaceItems = [
  ['idea', 'Auto-link invoices to conversations', 'Every invoice knows its client, thread, project and payment.', 'open', rahul.id, 6 * DAY],
  ['idea', 'WhatsApp import for client chats', 'Freelancers live on WhatsApp — meet them there.', 'open', maya.id, 5 * DAY],
  ['task', 'Draft the one-pager', 'Problem, wedge, market, ask.', 'open', rahul.id, 3 * DAY],
  ['task', 'Confirm company name', 'Needed for the incubator application.', 'open', aarav.id, DAY],
  ['task', 'Design first invoice template', '', 'done', maya.id, 4 * DAY],
  ['decision', 'Start with freelancers, not SMBs', 'Smaller wedge, faster feedback loop. Decided on call.', 'open', aarav.id, 5 * DAY],
  ['milestone', 'First 10 user interviews done', '7/10 said invoicing chaos is their top pain.', 'open', maya.id, 2 * DAY],
];
for (const [type, title, body, status, creator, ago] of spaceItems) {
  const r = item.run(spaceId, type, title, body, status, creator, now() - ago);
  ftsIndex('space_item', r.lastInsertRowid, spaceId, `${title} ${body}`);
}

// Space chat
const spaceConvo = db.prepare(`SELECT * FROM conversations WHERE kind='space' AND space_id=?`).get(spaceId);
function spaceSay(from, body, agoMs) {
  const signals = detectSignals(body);
  const r = db.prepare(`INSERT INTO messages (conversation_id, sender_id, body, priority, signals, created_at) VALUES (?,?,?,?,?,?)`)
    .run(spaceConvo.id, from.id, body, classifyPriority(body), JSON.stringify(signals), now() - agoMs);
  ftsIndex('message', Number(r.lastInsertRowid), spaceConvo.id, body);
}
spaceSay(maya, 'Interview #7 done. She said: "I chase payments more than I design." That is our tagline energy.', 2 * DAY);
spaceSay(rahul, 'What if the invoice reminder sounds like the freelancer, not a robot? Tone-matched nudges.', 2 * DAY - 2 * HOUR);
spaceSay(aarav, 'Logging that as an idea. Let’s decide the name this week — deadline is Friday.', DAY);

// ============================================================ Ikvizz EDU ----
// Aarav's knowledge universe: the AI chain + a deliberate gap (weak Limits
// under strong Calculus) so the Gap Detector fires on first login.
const concept = db.prepare(`INSERT INTO concepts (user_id, name, emoji, notes, mastery, last_studied, created_at) VALUES (?,?,?,?,?,?,?)`);
const cIds = {};
const CONCEPTS = [ // emoji column carries Ikvizz icon names
  ['Artificial Intelligence', 'cpu', 'The umbrella field.', 88, 2],
  ['Machine Learning', 'chart', 'Learning from data.', 76, 4],
  ['Neural Networks', 'network', 'Layers, weights, backprop.', 58, 9],
  ['CNN', 'image', 'Convolutions for vision.', 42, 16],
  ['ResNet', 'layers', 'Skip connections.', 22, 30],
  ['Calculus', 'sigma', 'Change and accumulation.', 74, 6],
  ['Limits', 'limit', 'The foundation under derivatives.', 28, 45],
  ['Derivatives', 'trend', 'Rates of change.', 60, 8],
  ['Linear Algebra', 'grid', 'Vectors and matrices.', 65, 12],
];
for (const [name, emoji, notes, mastery, daysAgo] of CONCEPTS) {
  const r = concept.run(aarav.id, name, emoji, notes, mastery, now() - daysAgo * DAY, now() - 60 * DAY);
  cIds[name] = Number(r.lastInsertRowid);
}
const link = db.prepare(`INSERT INTO concept_links (user_id, from_id, to_id) VALUES (?,?,?)`);
const CHAINS = [ // [prerequisite, dependent] — you must know the first to learn the second
  ['Artificial Intelligence', 'Machine Learning'],
  ['Machine Learning', 'Neural Networks'],
  ['Neural Networks', 'CNN'],
  ['CNN', 'ResNet'],
  ['Limits', 'Derivatives'],
  ['Derivatives', 'Calculus'],
  ['Calculus', 'Machine Learning'],
  ['Linear Algebra', 'Neural Networks'],
];
for (const [from, to] of CHAINS) link.run(aarav.id, cIds[from], cIds[to]);

// =========================================================== Ikvizz LIFE ----
const lifeItem = db.prepare(`INSERT INTO life_items (user_id, room, title, body, due_at, status, created_at) VALUES (?,?,?,?,?,?,?)`);
const LIFE = [ // [room, title, body, dueInHours|null, status]
  ['kitchen', 'Buy vegetables & milk', 'Tomatoes, spinach, 2L milk', 20, 'open'],
  ['kitchen', 'Meal prep for the week', '', null, 'open'],
  ['money',   'Pay electricity bill', '₹2,340 · autopay failed last month', 40, 'open'],
  ['money',   'Review mutual fund SIP', '', null, 'open'],
  ['vault',   'Renew passport', 'Expires next month — book slot', 6 * 24, 'open'],
  ['vault',   'AC warranty ends', 'Registered Jan 2025 · 18-month warranty', 12 * 24, 'open'],
  ['garage',  'Bike service due', '6,000 km checkup', 3 * 24, 'open'],
  ['family',  "Amma's knee checkup", 'Book the cab for the 15th', 8 * 24, 'open'],
  ['family',  "Cousin's wedding gift", '', null, 'open'],
  ['bedroom', 'Sleep by 11pm this week', 'Average was 1:20am last week', null, 'open'],
  ['study',   'Finish ResNet paper', 'Deep Residual Learning — He et al.', null, 'open'],
];
for (const [room, title, body, dueH, status] of LIFE) {
  lifeItem.run(aarav.id, room, title, body, dueH ? now() + dueH * 3600_000 : null, status, now() - 2 * DAY);
}

const habit = db.prepare(`INSERT INTO habits (user_id, name, emoji, streak, last_done, created_at) VALUES (?,?,?,?,?,?)`);
habit.run(aarav.id, 'Morning walk', '🚶', 6, now() - 20 * 3600_000, now() - 30 * DAY);
habit.run(aarav.id, 'Reading 20 min', '📖', 15, now() - 22 * 3600_000, now() - 60 * DAY);
habit.run(aarav.id, 'Meditation', '🧘', 2, now() - 26 * 3600_000, now() - 10 * DAY);
habit.run(aarav.id, 'No sugar', '🍬', 0, 0, now() - 5 * DAY);

console.log(`
  Demo world created ✓
  ────────────────────────────────
  Sign in as any of these (password: aether123)
    aarav   — the main demo account (start here)
    rahul   — close friend & co-founder
    maya    — colleague
    amma    — family
    vikram  — investor
`);
