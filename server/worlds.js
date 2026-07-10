// ============================================================================
// IKVIZZ WORLDS — EDU · LIFE · HORIZON
// One core intelligence (db + brain), three different presentations of it.
// This module is the world-specific domain logic; the SPA renders each world.
// ============================================================================
import { Router } from 'express';
import { db, now } from './db.js';
import { httpErr } from './auth.js';

export const worlds = Router(); // mounted under /api AFTER authMiddleware

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' }); }
};

const DAY = 86_400_000;

// ============================================================================
// IKVIZZ EDU — Knowledge Universe
// ============================================================================

/** Mastery decays exponentially (τ = 40 days). A planet you ignore dims. */
export function effectiveMastery(concept, at = Date.now()) {
  const days = Math.max(0, (at - concept.last_studied) / DAY);
  return Math.max(2, concept.mastery * Math.exp(-days / 40));
}

function eduUniverse(userId) {
  const concepts = db.prepare(`SELECT * FROM concepts WHERE user_id=?`).all(userId)
    .map(c => ({ ...c, effective: Math.round(effectiveMastery(c)) }));
  const links = db.prepare(`SELECT id, from_id, to_id FROM concept_links WHERE user_id=?`).all(userId);
  const byId = new Map(concepts.map(c => [c.id, c]));

  // Knowledge Gap Detector: you're working on X but its prerequisite is weak.
  const gaps = [];
  for (const l of links) {
    const prereq = byId.get(l.from_id), dependent = byId.get(l.to_id);
    if (!prereq || !dependent) continue;
    const workingOnDependent = dependent.effective >= 45 || (Date.now() - dependent.last_studied) < 7 * DAY;
    if (workingOnDependent && prereq.effective < 40) {
      gaps.push({
        prereq: { id: prereq.id, name: prereq.name, effective: prereq.effective },
        dependent: { id: dependent.id, name: dependent.name, effective: dependent.effective },
        advice: `You're working on “${dependent.name}”, but its prerequisite “${prereq.name}” is at ${prereq.effective}% — shore it up first.`,
      });
    }
  }

  // Review queue: dimmest planets first, then longest-unvisited.
  const review = concepts
    .filter(c => c.effective < 55)
    .sort((a, b) => a.effective - b.effective || a.last_studied - b.last_studied)
    .slice(0, 6);

  // Today's plan: one gap prerequisite, one dim review, one strength to push higher.
  const plan = [];
  if (gaps[0]) plan.push({ kind: 'gap', concept_id: gaps[0].prereq.id, why: gaps[0].advice });
  const dim = review.find(c => !plan.some(p => p.concept_id === c.id));
  if (dim) plan.push({ kind: 'review', concept_id: dim.id, why: `“${dim.name}” has faded to ${dim.effective}% — a short session restores it.` });
  const push = concepts.filter(c => c.effective >= 55 && c.effective < 85).sort((a, b) => b.effective - a.effective)[0];
  if (push && !plan.some(p => p.concept_id === push.id)) {
    plan.push({ kind: 'advance', concept_id: push.id, why: `“${push.name}” is at ${push.effective}% — one push takes it to mastery.` });
  }

  return { concepts, links, gaps, review, plan };
}

worlds.get('/edu/universe', wrap((req, res) => res.json(eduUniverse(req.userId))));

worlds.post('/edu/concepts', wrap((req, res) => {
  const { name, emoji, notes, prereqOf } = req.body || {};
  if (!name?.trim()) throw httpErr(400, 'Name the concept.');
  const r = db.prepare(`INSERT INTO concepts (user_id, name, emoji, notes, mastery, last_studied, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(req.userId, name.trim(), emoji || '🪐', notes || '', 10, now(), now());
  const id = Number(r.lastInsertRowid);
  if (prereqOf) { // new concept is a PREREQUISITE of an existing one
    const target = db.prepare(`SELECT id FROM concepts WHERE id=? AND user_id=?`).get(Number(prereqOf), req.userId);
    if (target) db.prepare(`INSERT OR IGNORE INTO concept_links (user_id, from_id, to_id) VALUES (?,?,?)`).run(req.userId, id, target.id);
  }
  res.json(db.prepare(`SELECT * FROM concepts WHERE id=?`).get(id));
}));

worlds.post('/edu/concepts/:id/study', wrap((req, res) => {
  const c = db.prepare(`SELECT * FROM concepts WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!c) throw httpErr(404, 'Concept not found.');
  const quality = [1, 2, 3].includes(req.body?.quality) ? req.body.quality : 2;
  // Studying restores decayed mastery first, then builds on it.
  const base = effectiveMastery(c);
  const gain = quality === 1 ? 6 : quality === 2 ? 12 : 20;
  const mastery = Math.min(100, base + gain);
  db.prepare(`UPDATE concepts SET mastery=?, last_studied=? WHERE id=?`).run(mastery, now(), c.id);
  db.prepare(`INSERT INTO study_log (user_id, concept_id, quality, created_at) VALUES (?,?,?,?)`).run(req.userId, c.id, quality, now());
  res.json({ ...db.prepare(`SELECT * FROM concepts WHERE id=?`).get(c.id), effective: Math.round(mastery) });
}));

worlds.post('/edu/links', wrap((req, res) => {
  const { fromId, toId } = req.body || {};
  const a = db.prepare(`SELECT id FROM concepts WHERE id=? AND user_id=?`).get(Number(fromId), req.userId);
  const b = db.prepare(`SELECT id FROM concepts WHERE id=? AND user_id=?`).get(Number(toId), req.userId);
  if (!a || !b || a.id === b.id) throw httpErr(400, 'Pick two different concepts of yours.');
  db.prepare(`INSERT OR IGNORE INTO concept_links (user_id, from_id, to_id) VALUES (?,?,?)`).run(req.userId, a.id, b.id);
  res.json({ ok: true });
}));

worlds.delete('/edu/concepts/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM concepts WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Exam Simulator — not a mock test. It measures honest recall under time
// pressure, predicts likely mistakes from weak prerequisites, and forecasts
// retention decay per concept.
// ---------------------------------------------------------------------------
worlds.get('/edu/exam', wrap((req, res) => {
  const u = eduUniverse(req.userId);
  const byId = new Map(u.concepts.map(c => [c.id, c]));
  const weakPrereqsOf = id => u.links.filter(l => l.to_id === id)
    .map(l => byId.get(l.from_id)).filter(p => p && p.effective < 40);

  // Weakest first, capped at 8 — a session, not a marathon
  const questions = [...u.concepts]
    .sort((a, b) => a.effective - b.effective)
    .slice(0, 8)
    .map(c => {
      const weak = weakPrereqsOf(c.id);
      return {
        concept_id: c.id, name: c.name, emoji: c.emoji, effective: c.effective,
        prompt: `Without looking anything up — explain “${c.name}” out loud in one minute.`,
        risk: weak.length
          ? `Likely mistake: shaky ${weak.map(w => `“${w.name}”`).join(' and ')} underneath (${weak.map(w => w.effective + '%').join(', ')}).`
          : c.effective < 30 ? 'High decay — expect blanks. That is useful data, not failure.' : '',
        timeLimitSec: 30,
      };
    });

  // Retention forecast: days until each concept dips below 40%
  const forecast = u.concepts
    .filter(c => c.effective >= 40)
    .map(c => {
      const daysTotal = 40 * Math.log(Math.max(c.mastery, 40.01) / 40);
      const daysLeft = Math.max(0, Math.round(daysTotal - (Date.now() - c.last_studied) / DAY));
      return { concept_id: c.id, name: c.name, daysLeft };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 5);

  res.json({ questions, forecast });
}));

worlds.post('/edu/exam/submit', wrap((req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results.slice(0, 20) : [];
  const report = [];
  for (const r of results) {
    const c = db.prepare(`SELECT * FROM concepts WHERE id=? AND user_id=?`).get(Number(r.conceptId), req.userId);
    if (!c) continue;
    const eff = effectiveMastery(c);
    // An exam MEASURES: blanks correct the record downward; recall reinforces.
    let mastery, quality;
    if (r.outcome === 'blank') { mastery = Math.min(eff, Math.max(8, eff * 0.6)); quality = 1; }
    else if (r.outcome === 'shaky') { mastery = Math.min(100, eff + 5); quality = 2; }
    else { mastery = Math.min(100, eff + 12); quality = 3; }
    db.prepare(`UPDATE concepts SET mastery=?, last_studied=? WHERE id=?`).run(mastery, now(), c.id);
    db.prepare(`INSERT INTO study_log (user_id, concept_id, quality, created_at) VALUES (?,?,?,?)`).run(req.userId, c.id, quality, now());
    report.push({ concept_id: c.id, name: c.name, before: Math.round(eff), after: Math.round(mastery), outcome: r.outcome });
  }
  res.json({ report, universe: eduUniverse(req.userId) });
}));

// ---------------------------------------------------------------------------
// Assignments (Phase 11) — deadlines with an optional concept attached.
// Anything due soon surfaces in the Daily Briefing, next to bills and promises.
// ---------------------------------------------------------------------------
worlds.get('/edu/assignments', wrap((req, res) => {
  const assignments = db.prepare(`
    SELECT a.*, c.name AS concept_name, c.emoji AS concept_emoji FROM assignments a
    LEFT JOIN concepts c ON c.id = a.concept_id
    WHERE a.user_id=? ORDER BY a.status='open' DESC, COALESCE(a.due_at, 9e15) ASC
  `).all(req.userId);
  res.json({ assignments });
}));

worlds.post('/edu/assignments', wrap((req, res) => {
  const { title, conceptId, dueAt } = req.body || {};
  if (!title?.trim()) throw httpErr(400, 'Name the assignment.');
  let cid = null;
  if (conceptId) cid = db.prepare(`SELECT id FROM concepts WHERE id=? AND user_id=?`).get(Number(conceptId), req.userId)?.id || null;
  const r = db.prepare(`INSERT INTO assignments (user_id, title, concept_id, due_at, created_at) VALUES (?,?,?,?,?)`)
    .run(req.userId, title.trim().slice(0, 200), cid, dueAt ? Number(dueAt) : null, now());
  res.json(db.prepare(`SELECT * FROM assignments WHERE id=?`).get(r.lastInsertRowid));
}));

worlds.patch('/edu/assignments/:id', wrap((req, res) => {
  const a = db.prepare(`SELECT * FROM assignments WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!a) throw httpErr(404, 'Not found.');
  const status = ['open', 'done'].includes(req.body?.status) ? req.body.status : a.status;
  db.prepare(`UPDATE assignments SET status=? WHERE id=?`).run(status, a.id);
  res.json({ ok: true });
}));

worlds.delete('/edu/assignments/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM assignments WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Flash cards (Phase 11) — recall drills that feed the SAME honest mastery
// machinery: grading a card is a study session on its concept, half-weight.
// ---------------------------------------------------------------------------
worlds.get('/edu/flashcards', wrap((req, res) => {
  const conceptId = Number(req.query.conceptId) || null;
  const cards = db.prepare(`
    SELECT f.*, c.name AS concept_name FROM flashcards f JOIN concepts c ON c.id = f.concept_id
    WHERE f.user_id=? ${conceptId ? 'AND f.concept_id=?' : ''} ORDER BY f.created_at DESC
  `).all(...(conceptId ? [req.userId, conceptId] : [req.userId]));
  res.json({ cards });
}));

worlds.post('/edu/flashcards', wrap((req, res) => {
  const { conceptId, front, back } = req.body || {};
  const c = db.prepare(`SELECT id FROM concepts WHERE id=? AND user_id=?`).get(Number(conceptId), req.userId);
  if (!c) throw httpErr(404, 'Pick one of your concepts.');
  if (!front?.trim() || !back?.trim()) throw httpErr(400, 'A card needs a front and a back.');
  const r = db.prepare(`INSERT INTO flashcards (user_id, concept_id, front, back, created_at) VALUES (?,?,?,?,?)`)
    .run(req.userId, c.id, front.trim().slice(0, 300), back.trim().slice(0, 500), now());
  res.json(db.prepare(`SELECT * FROM flashcards WHERE id=?`).get(r.lastInsertRowid));
}));

worlds.delete('/edu/flashcards/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM flashcards WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

/** A review session: up to 10 cards, dimmest concepts first, least-recently-seen. */
worlds.get('/edu/flashcards/review', wrap((req, res) => {
  const cards = db.prepare(`
    SELECT f.*, c.name AS concept_name, c.mastery, c.last_studied FROM flashcards f
    JOIN concepts c ON c.id = f.concept_id WHERE f.user_id=?
  `).all(req.userId)
    .map(f => ({ ...f, effective: Math.round(effectiveMastery(f)) }))
    .sort((a, b) => a.effective - b.effective || a.last_seen - b.last_seen)
    .slice(0, 10)
    .map(({ mastery, last_studied, ...f }) => f);
  res.json({ cards });
}));

worlds.post('/edu/flashcards/:id/grade', wrap((req, res) => {
  const f = db.prepare(`SELECT * FROM flashcards WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!f) throw httpErr(404, 'Card not found.');
  const quality = [1, 2, 3].includes(req.body?.quality) ? req.body.quality : 2;
  db.prepare(`UPDATE flashcards SET reps=reps+1, last_grade=?, last_seen=? WHERE id=?`).run(quality, now(), f.id);
  // Half-weight study session on the underlying concept — cards drill, sessions build
  const c = db.prepare(`SELECT * FROM concepts WHERE id=?`).get(f.concept_id);
  const base = effectiveMastery(c);
  const gain = quality === 1 ? 2 : quality === 2 ? 5 : 9;
  const mastery = Math.min(100, base + gain);
  db.prepare(`UPDATE concepts SET mastery=?, last_studied=? WHERE id=?`).run(mastery, now(), c.id);
  db.prepare(`INSERT INTO study_log (user_id, concept_id, quality, created_at) VALUES (?,?,?,?)`).run(req.userId, c.id, quality, now());
  res.json({ ok: true, concept: { id: c.id, name: c.name, effective: Math.round(mastery) } });
}));

// ---------------------------------------------------------------------------
// Study Rooms (Phase 11) — Living Spaces born for studying: same chat, tasks
// and decisions, plus notes & questions. Listed inside the EDU world.
// ---------------------------------------------------------------------------
worlds.get('/edu/rooms', wrap((req, res) => {
  const rooms = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM space_members WHERE space_id=s.id) AS member_count,
           (SELECT COUNT(*) FROM space_items WHERE space_id=s.id AND type='note') AS notes,
           (SELECT COUNT(*) FROM space_items WHERE space_id=s.id AND type='question' AND status='open') AS open_questions
    FROM spaces s JOIN space_members sm ON sm.space_id=s.id
    WHERE sm.user_id=? AND s.kind='study' ORDER BY s.created_at DESC
  `).all(req.userId);
  res.json({ rooms });
}));

// ---------------------------------------------------------------------------
// Learning DNA — how YOU learn, computed transparently from your study log.
// ---------------------------------------------------------------------------
worlds.get('/edu/dna', wrap((req, res) => {
  const log = db.prepare(`SELECT * FROM study_log WHERE user_id=? ORDER BY created_at ASC`).all(req.userId);
  const t = Date.now();
  const days14 = new Set(log.filter(l => t - l.created_at < 14 * DAY).map(l => new Date(l.created_at).toDateString()));
  const last7 = log.filter(l => t - l.created_at < 7 * DAY).length;
  const prev7 = log.filter(l => t - l.created_at >= 7 * DAY && t - l.created_at < 14 * DAY).length;
  const avgQ = log.length ? log.reduce((s, l) => s + l.quality, 0) / log.length : 0;

  // Resilience: after a struggle (quality 1), did you come back to that concept within 3 days?
  const struggles = log.filter(l => l.quality === 1);
  const comebacks = struggles.filter(s =>
    log.some(l => l.concept_id === s.concept_id && l.created_at > s.created_at && l.created_at - s.created_at < 3 * DAY)).length;

  const hours = log.map(l => new Date(l.created_at).getHours());
  const hourMode = hours.length ? hours.sort((a, b) =>
    hours.filter(h => h === b).length - hours.filter(h => h === a).length)[0] : null;

  const style = avgQ >= 2.4 ? 'confident-recall' : comebacks / Math.max(1, struggles.length) > 0.5 ? 'resilient-looper' : 'steady-builder';

  res.json({
    sessions: log.length,
    consistency: Math.round((days14.size / 14) * 100),
    momentum: last7 - prev7,
    resilience: struggles.length ? Math.round((comebacks / struggles.length) * 100) : null,
    bestHour: hourMode,
    avgQuality: Math.round(avgQ * 10) / 10,
    style,
    styleNote: {
      'confident-recall': 'You retain well once learned — space your reviews further apart.',
      'resilient-looper': 'You come back after struggling — that loop is your superpower. Keep it.',
      'steady-builder': 'You build steadily — short daily sessions suit you better than cram blocks.',
    }[style],
    engine: 'heuristic — computed from your own study log, on this machine',
  });
}));

// ============================================================================
// IKVIZZ LIFE — Digital Home
// ============================================================================
export const ROOMS = [ // `emoji` carries an IKVIZZ icon name — the client renders our own icons
  { key: 'kitchen', label: 'Kitchen', emoji: 'pan',      hint: 'groceries & meals' },
  { key: 'bedroom', label: 'Bedroom', emoji: 'bed',      hint: 'sleep & rest' },
  { key: 'study',   label: 'Study',   emoji: 'book',     hint: 'learning & work' },
  { key: 'garage',  label: 'Garage',  emoji: 'car',      hint: 'vehicles & repairs' },
  { key: 'vault',   label: 'Vault',   emoji: 'shield',   hint: 'documents & warranties' },
  { key: 'money',   label: 'Money',   emoji: 'coins',    hint: 'bills & budgets' },
  { key: 'family',  label: 'Family',  emoji: 'heart',    hint: 'people & trusted circles' },
  { key: 'health',  label: 'Health',  emoji: 'pulse',    hint: 'appointments & meds' },   // Phase 12
  { key: 'travel',  label: 'Travel',  emoji: 'compass',  hint: 'trips & bookings' },      // Phase 12
  { key: 'garden',  label: 'Garden',  emoji: 'sprout',   hint: 'habits growing over time' },
];

worlds.get('/life', wrap((req, res) => {
  const items = db.prepare(`SELECT * FROM life_items WHERE user_id=? ORDER BY status='open' DESC, COALESCE(due_at, 9e15) ASC, created_at DESC`).all(req.userId);
  const habits = db.prepare(`SELECT * FROM habits WHERE user_id=? ORDER BY streak DESC`).all(req.userId);
  const goals = db.prepare(`SELECT * FROM goals WHERE user_id=? ORDER BY status='open' DESC, COALESCE(due_at, 9e15) ASC`).all(req.userId);
  res.json({ rooms: ROOMS, items, habits, goals });
}));

// ---------------------------------------------------------------------------
// Goals (Phase 12) — long arcs with honest, human-moved progress.
// ---------------------------------------------------------------------------
worlds.post('/life/goals', wrap((req, res) => {
  const { title, emoji, dueAt } = req.body || {};
  if (!title?.trim()) throw httpErr(400, 'Name the goal.');
  const r = db.prepare(`INSERT INTO goals (user_id, title, emoji, due_at, updated_at, created_at) VALUES (?,?,?,?,?,?)`)
    .run(req.userId, title.trim().slice(0, 200), emoji || 'target', dueAt ? Number(dueAt) : null, now(), now());
  res.json(db.prepare(`SELECT * FROM goals WHERE id=?`).get(r.lastInsertRowid));
}));

worlds.patch('/life/goals/:id', wrap((req, res) => {
  const g = db.prepare(`SELECT * FROM goals WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!g) throw httpErr(404, 'Not found.');
  const progress = Number.isFinite(Number(req.body?.progress))
    ? Math.max(0, Math.min(100, Math.round(Number(req.body.progress)))) : g.progress;
  const status = ['open', 'done', 'dropped'].includes(req.body?.status) ? req.body.status
    : progress >= 100 ? 'done' : g.status;
  db.prepare(`UPDATE goals SET progress=?, status=?, updated_at=? WHERE id=?`).run(progress, status, now(), g.id);
  res.json(db.prepare(`SELECT * FROM goals WHERE id=?`).get(g.id));
}));

worlds.delete('/life/goals/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM goals WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

worlds.post('/life/items', wrap((req, res) => {
  const { room, title, body, dueAt } = req.body || {};
  if (!ROOMS.some(r => r.key === room)) throw httpErr(400, 'Unknown room.');
  if (!title?.trim()) throw httpErr(400, 'Give it a title.');
  const r = db.prepare(`INSERT INTO life_items (user_id, room, title, body, due_at, created_at) VALUES (?,?,?,?,?,?)`)
    .run(req.userId, room, title.trim(), body || '', dueAt ? Number(dueAt) : null, now());
  res.json(db.prepare(`SELECT * FROM life_items WHERE id=?`).get(r.lastInsertRowid));
}));

worlds.patch('/life/items/:id', wrap((req, res) => {
  const item = db.prepare(`SELECT * FROM life_items WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!item) throw httpErr(404, 'Not found.');
  const status = ['open', 'done'].includes(req.body?.status) ? req.body.status : item.status;
  db.prepare(`UPDATE life_items SET status=? WHERE id=?`).run(status, item.id);
  res.json({ ok: true });
}));

worlds.delete('/life/items/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM life_items WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

worlds.post('/life/habits', wrap((req, res) => {
  const { name, emoji } = req.body || {};
  if (!name?.trim()) throw httpErr(400, 'Name the habit.');
  const r = db.prepare(`INSERT INTO habits (user_id, name, emoji, created_at) VALUES (?,?,?,?)`)
    .run(req.userId, name.trim(), emoji || '🌱', now());
  res.json(db.prepare(`SELECT * FROM habits WHERE id=?`).get(r.lastInsertRowid));
}));

worlds.post('/life/habits/:id/done', wrap((req, res) => {
  const h = db.prepare(`SELECT * FROM habits WHERE id=? AND user_id=?`).get(req.params.id, req.userId);
  if (!h) throw httpErr(404, 'Not found.');
  const t = now();
  const sameDay = new Date(h.last_done).toDateString() === new Date(t).toDateString();
  if (!sameDay) {
    const streak = (t - h.last_done) < 2 * DAY ? h.streak + 1 : 1; // grace of one missed night
    db.prepare(`UPDATE habits SET streak=?, last_done=? WHERE id=?`).run(streak, t, h.id);
  }
  res.json(db.prepare(`SELECT * FROM habits WHERE id=?`).get(h.id));
}));

worlds.delete('/life/habits/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM habits WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Crisis Predictor — notices patterns before they become emergencies.
// Transparent rules over your own data; every warning says what to do next.
// ---------------------------------------------------------------------------
worlds.get('/life/insights', wrap((req, res) => {
  const t = Date.now();
  const items = db.prepare(`SELECT * FROM life_items WHERE user_id=? AND status='open'`).all(req.userId);
  const habits = db.prepare(`SELECT * FROM habits WHERE user_id=?`).all(req.userId);
  const warnings = [];

  const overdue = items.filter(i => i.due_at && i.due_at < t);
  const moneyOverdue = overdue.filter(i => i.room === 'money');
  if (moneyOverdue.length) warnings.push({
    severity: 'critical', icon: 'coins', room: 'money',
    title: `${moneyOverdue.length === 1 ? 'A bill is' : moneyOverdue.length + ' bills are'} overdue`,
    advice: `“${moneyOverdue[0].title}” — late fees compound. Clear it today.`,
  });
  const otherOverdue = overdue.filter(i => i.room !== 'money');
  if (otherOverdue.length >= 2) warnings.push({
    severity: 'warn', icon: 'clock', room: otherOverdue[0].room,
    title: `${otherOverdue.length} things slipping past their dates`,
    advice: 'One focused catch-up hour prevents a pile-up week.',
  });

  // A cluster of deadlines = a crunch you can defuse early
  const next48 = items.filter(i => i.due_at && i.due_at > t && i.due_at < t + 2 * DAY);
  if (next48.length >= 3) warnings.push({
    severity: 'warn', icon: 'alert', room: next48[0].room,
    title: `${next48.length} deadlines land in the next 48 hours`,
    advice: 'Do the smallest one now — momentum beats panic.',
  });

  // Withering streaks: a habit you built is about to break
  for (const h of habits.filter(h => h.streak >= 5 && h.last_done && t - h.last_done > 1.5 * DAY && t - h.last_done < 4 * DAY)) {
    warnings.push({
      severity: 'warn', icon: 'sprout', room: 'garden',
      title: `Your ${h.streak}-day “${h.name}” streak is withering`,
      advice: 'One small session today keeps the tree alive.',
    });
  }

  // Documents expiring soon (vault items due within 7 days)
  const vaultSoon = items.filter(i => i.room === 'vault' && i.due_at && i.due_at > t && i.due_at < t + 7 * DAY);
  for (const v of vaultSoon) warnings.push({
    severity: 'info', icon: 'shield', room: 'vault',
    title: `“${v.title}” needs attention within a week`,
    advice: 'Renewals queue up — book the slot before it becomes urgent.',
  });

  // Goals drifting toward their deadline with most of the road still ahead
  const goals = db.prepare(`SELECT * FROM goals WHERE user_id=? AND status='open'`).all(req.userId);
  for (const g of goals.filter(g => g.due_at && g.due_at > t && g.due_at < t + 7 * DAY && g.progress < 70)) {
    warnings.push({
      severity: 'warn', icon: 'target', room: 'garden',
      title: `“${g.title}” is due in ${Math.max(1, Math.round((g.due_at - t) / DAY))} day(s) at ${g.progress}%`,
      advice: 'Break off one concrete step today — arcs bend with small pushes.',
    });
  }

  res.json({ warnings: warnings.slice(0, 5), engine: 'heuristic — pattern rules over your local data' });
}));

// ============================================================================
// IKVIZZ HORIZON — everything you know, as one navigable universe
// ============================================================================
worlds.get('/horizon', wrap((req, res) => {
  const uid = req.userId;
  const nodes = [];

  for (const p of db.prepare(`
    SELECT r.other_id, r.kind, r.closeness, u.display_name, u.avatar_hue
    FROM relationships r JOIN users u ON u.id=r.other_id WHERE r.user_id=?`).all(uid)) {
    const convo = db.prepare(`SELECT id FROM conversations WHERE kind='dm' AND a_id=? AND b_id=?`)
      .get(Math.min(uid, p.other_id), Math.max(uid, p.other_id));
    const lastMsg = convo ? db.prepare(`SELECT MAX(created_at) AS t FROM messages WHERE conversation_id=?`).get(convo.id)?.t : null;
    const unread = convo ? db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=? AND sender_id!=? AND id > COALESCE((SELECT last_read_id FROM reads WHERE conversation_id=? AND user_id=?),0)`)
      .get(convo.id, uid, convo.id, uid).c : 0;
    nodes.push({
      type: 'person', label: p.display_name, sub: p.kind, hue: p.avatar_hue,
      weight: 4 - p.closeness,                                   // inner circle = bigger star
      heat: Math.min(1, unread * 0.4 + (lastMsg && (Date.now() - lastMsg) < DAY ? 0.5 : 0.1)), // brightness = importance today
      ref: convo ? '/chat/' + convo.id : '/people',
      body: p.display_name + ' ' + p.kind,
    });
  }

  for (const s of db.prepare(`
    SELECT s.* FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE m.user_id=?`).all(uid)) {
    const openTasks = db.prepare(`SELECT COUNT(*) AS c FROM space_items WHERE space_id=? AND type='task' AND status='open'`).get(s.id).c;
    nodes.push({
      type: 'space', label: s.name, sub: s.emoji + ' living space', hue: 258,
      weight: 3, heat: Math.min(1, 0.3 + openTasks * 0.2),
      ref: '/space/' + s.id, body: s.name + ' ' + s.description,
    });
  }

  for (const c of db.prepare(`SELECT * FROM concepts WHERE user_id=?`).all(uid)) {
    const eff = effectiveMastery(c) / 100;
    nodes.push({
      type: 'concept', label: c.name, sub: c.emoji + ' ' + Math.round(eff * 100) + '% mastered', hue: 174,
      weight: 1.5 + eff * 2, heat: eff, ref: '/edu', body: c.name + ' ' + c.notes,
    });
  }

  for (const m of db.prepare(`SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 14`).all(uid)) {
    nodes.push({
      type: 'memory', label: m.body.slice(0, 42) + (m.body.length > 42 ? '…' : ''), sub: '⭐ memory', hue: 45,
      weight: 1.2, heat: 0.5, ref: '/memory', body: m.body + ' ' + m.note,
    });
  }

  for (const p of db.prepare(`SELECT p.*, u.display_name AS to_name FROM promises p LEFT JOIN users u ON u.id=p.to_id WHERE p.user_id=? AND p.status='open' LIMIT 8`).all(uid)) {
    nodes.push({
      type: 'promise', label: p.body.slice(0, 42) + (p.body.length > 42 ? '…' : ''), sub: '🤝 open promise', hue: 28,
      weight: 1.4, heat: 0.85, ref: '/today', body: p.body,
    });
  }

  res.json({ nodes });
}));
