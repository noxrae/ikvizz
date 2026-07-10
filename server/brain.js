// ============================================================================
// IKVIZZ — The Brain (v0: transparent local heuristics)
//
// Honesty is a feature: everything here is deterministic, explainable and runs
// 100% on the user's machine. Each function is a seam where an open-weight
// model (Ollama / Llama / Qwen) can slot in later WITHOUT changing callers:
//   classify(text, rel)  -> priority stream
//   detectSignals(text)  -> promise / idea / question / decision
//   briefing(userId)     -> the Daily Home Screen
// ============================================================================
import { db } from './db.js';

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Priority Streams — replace notifications. AI decides: critical | important
// | interesting | normal. Relationship closeness raises the floor.
// ---------------------------------------------------------------------------
const CRITICAL = /\b(urgent|asap|emergency|immediately|right now|deadline today|help me|hospital|accident|critical)\b/i;
const IMPORTANT = /\b(deadline|by (today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|meeting|interview|payment|invoice|contract|exam|due|confirm|approve|decision|sign|submit)\b/i;
const INTERESTING = /\b(idea|check this|look at this|interesting|thought you'?d|what if|imagine|found this|article|link)\b|https?:\/\//i;

export function classifyPriority(text, closeness = 2) {
  if (CRITICAL.test(text)) return 'critical';
  if (IMPORTANT.test(text)) return 'important';
  // Inner-circle questions matter more than outer-circle small talk
  if (closeness === 1 && /\?\s*$/.test(text.trim())) return 'important';
  if (INTERESTING.test(text)) return 'interesting';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Signal detection — what the message *means*, not just what it says.
// Returns a list of {type, extract} the UI can act on.
// ---------------------------------------------------------------------------
const PROMISE = /\b(i(?:'|’)?ll|i will|i promise|i can send|i(?:'|’)?m going to|will (?:send|share|call|do|finish|complete|fix|deliver))\b/i;
const DUE_HINT = /\b(today|tonight|tomorrow|by \w+(?: \w+)?|this (?:week|weekend|month)|next (?:week|month|monday|tuesday|wednesday|thursday|friday))\b/i;
const IDEA = /\b(idea|what if|we (?:should|could)|imagine if|how about|it would be (?:cool|great|amazing))\b/i;
const DECISION = /\b(let(?:'|’)?s (?:go with|do|finalize|pick)|we (?:decided|agreed)|final answer|decision:)\b/i;
const QUESTION = /\?\s*$/;

export function detectSignals(text) {
  const t = text.trim();
  const signals = [];
  if (PROMISE.test(t)) {
    const due = t.match(DUE_HINT);
    signals.push({ type: 'promise', due: due ? due[0] : '' });
  }
  if (IDEA.test(t)) signals.push({ type: 'idea' });
  if (DECISION.test(t)) signals.push({ type: 'decision' });
  if (QUESTION.test(t)) signals.push({ type: 'question' });
  return signals;
}

// ---------------------------------------------------------------------------
// Daily Briefing — "3 promises due, 2 conversations waiting, 4 ideas worth
// revisiting." The home screen is a summary of your relationships, not an inbox.
// ---------------------------------------------------------------------------
export function buildBriefing(userId) {
  const nowTs = Date.now();

  // Promises I made that are still open
  const myPromises = db.prepare(`
    SELECT p.*, u.display_name AS to_name FROM promises p
    LEFT JOIN users u ON u.id = p.to_id
    WHERE p.user_id = ? AND p.status = 'open'
    ORDER BY p.created_at ASC LIMIT 10
  `).all(userId);

  // Promises made TO me that are still open
  const owedToMe = db.prepare(`
    SELECT p.*, u.display_name AS from_name FROM promises p
    JOIN users u ON u.id = p.user_id
    WHERE p.to_id = ? AND p.status = 'open'
    ORDER BY p.created_at ASC LIMIT 10
  `).all(userId);

  // Conversations waiting: last message is from the other person, unread or
  // ends in a question, and I haven't replied.
  const waiting = db.prepare(`
    SELECT c.id AS conversation_id,
           CASE WHEN m.kind='sealed' THEN '🔒 Encrypted message' ELSE m.body END AS body,
           m.created_at, m.priority,
           u.id AS other_id, u.display_name AS other_name, u.avatar_hue, u.avatar_url
    FROM conversations c
    JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
    JOIN users u ON u.id = m.sender_id
    WHERE c.kind = 'dm' AND (c.a_id = ? OR c.b_id = ?) AND m.sender_id != ?
      AND m.id > COALESCE((SELECT last_read_id FROM reads WHERE conversation_id = c.id AND user_id = ?), 0)
    ORDER BY CASE m.priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, m.created_at DESC
    LIMIT 8
  `).all(userId, userId, userId, userId);

  // Ideas worth revisiting: idea-flagged messages in my conversations, 2+ days old
  const ideas = db.prepare(`
    SELECT m.id, m.body, m.created_at, u.display_name AS from_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    WHERE (c.a_id = ? OR c.b_id = ? OR c.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
      AND m.signals LIKE '%"idea"%'
      AND m.created_at < ?
    ORDER BY m.created_at DESC LIMIT 6
  `).all(userId, userId, userId, nowTs - 2 * DAY);

  // Recent memories (things explicitly asked to remember)
  const memories = db.prepare(`
    SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
  `).all(userId);

  // Open tasks assigned in my spaces
  const openTasks = db.prepare(`
    SELECT si.*, s.name AS space_name, s.emoji AS space_emoji
    FROM space_items si JOIN spaces s ON s.id = si.space_id
    WHERE si.type = 'task' AND si.status = 'open'
      AND si.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)
    ORDER BY si.created_at ASC LIMIT 6
  `).all(userId);

  // IKVIZZ LIFE: things in your home that are due soon or overdue
  const lifeDue = db.prepare(`
    SELECT * FROM life_items
    WHERE user_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?
    ORDER BY due_at ASC LIMIT 6
  `).all(userId, nowTs + DAY);

  // IKVIZZ EDU: assignments landing within 48h (Phase 11)
  const assignmentsDue = db.prepare(`
    SELECT a.*, c.name AS concept_name FROM assignments a
    LEFT JOIN concepts c ON c.id = a.concept_id
    WHERE a.user_id = ? AND a.status = 'open' AND a.due_at IS NOT NULL AND a.due_at < ?
    ORDER BY a.due_at ASC LIMIT 5
  `).all(userId, nowTs + 2 * DAY);

  // IKVIZZ EDU: the dimmest planets — what your knowledge universe wants reviewed
  const reviewConcepts = db.prepare(`SELECT * FROM concepts WHERE user_id = ?`).all(userId)
    .map(c => ({ ...c, effective: Math.round(Math.max(2, c.mastery * Math.exp(-Math.max(0, (nowTs - c.last_studied) / DAY) / 40))) }))
    .filter(c => c.effective < 45)
    .sort((a, b) => a.effective - b.effective)
    .slice(0, 3);

  // Relationship Health: friendships quietly drifting — suggested, never forced
  const drifting = db.prepare(`
    SELECT r.other_id, r.kind, u.display_name, u.avatar_hue, u.avatar_url,
           (SELECT MAX(m.created_at) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.kind='dm' AND ((c.a_id=? AND c.b_id=r.other_id) OR (c.b_id=? AND c.a_id=r.other_id))
           ) AS last_ts,
           (SELECT c2.id FROM conversations c2
            WHERE c2.kind='dm' AND ((c2.a_id=? AND c2.b_id=r.other_id) OR (c2.b_id=? AND c2.a_id=r.other_id))
           ) AS conversation_id
    FROM relationships r JOIN users u ON u.id = r.other_id
    WHERE r.user_id = ?
  `).all(userId, userId, userId, userId, userId)
    .filter(r => r.last_ts && (nowTs - r.last_ts) > 14 * DAY)
    .sort((a, b) => a.last_ts - b.last_ts)
    .slice(0, 3)
    .map(r => ({ ...r, daysSilent: Math.floor((nowTs - r.last_ts) / DAY) }));

  return { myPromises, owedToMe, waiting, ideas, memories, openTasks, lifeDue, assignmentsDue, reviewConcepts, drifting, generatedAt: nowTs };
}

// ---------------------------------------------------------------------------
// Intent Engine — richer than "typing…". The client reports raw editing
// activity; this maps it to a human intent word.
// ---------------------------------------------------------------------------
export function inferIntent({ draftLength = 0, msSinceKeystroke = 0, deletedRecently = false }) {
  if (deletedRecently && draftLength > 40) return 'reflecting';
  if (msSinceKeystroke > 4000 && draftLength > 0) return 'thinking';
  if (draftLength > 200) return 'writing';
  if (draftLength > 0) return 'writing';
  return 'thinking';
}

export const CONTEXTS = [
  { key: 'available', label: 'Available' },
  { key: 'working',   label: 'Working' },
  { key: 'meeting',   label: 'In a meeting' },
  { key: 'deepwork',  label: 'Locked in' },
  { key: 'driving',   label: 'Driving' },
  { key: 'gym',       label: 'At the gym' },
  { key: 'sleeping',  label: 'Sleeping' },
  { key: 'vacation',  label: 'On vacation' },
  // the honest statuses nobody's app lets you say
  { key: 'grass',     label: 'Touching grass' },
  { key: 'doomscroll',label: 'Doom-scrolling' },
  { key: 'mainchar',  label: 'Main character mode' },
  { key: 'lowbattery',label: 'Social battery low' },
];
