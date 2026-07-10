// ============================================================================
// IKVIZZ — AI layer. Local-first, honestly labeled.
//
// If Ollama (http://localhost:11434) is running, summaries use a real local
// LLM — the response says which model. If not, we fall back to a transparent
// extractive summary built from the brain's signals, labeled "heuristic".
// Nothing ever leaves the machine either way.
// ============================================================================
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

let cached = { at: 0, model: null };

/** Detect Ollama and pick a model (cached for 60s). */
export async function ollamaModel() {
  if (Date.now() - cached.at < 60_000) return cached.model;
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1000) });
    const d = await r.json();
    const names = (d.models || []).map(m => m.name);
    // Prefer small fast chat models if present
    const preferred = names.find(n => /llama3|qwen|mistral|phi|gemma/i.test(n)) || names[0] || null;
    cached = { at: Date.now(), model: preferred };
  } catch {
    cached = { at: Date.now(), model: null };
  }
  return cached.model;
}

async function ollamaGenerate(model, prompt) {
  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3, num_predict: 400 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error('Ollama error ' + r.status);
  return (await r.json()).response?.trim();
}

/**
 * Summarize a conversation. `messages` = [{from, body, signals, priority, created_at}]
 * (sealed messages must be filtered out by the caller — never feed ciphertext or
 * expect the AI to see what humans encrypted).
 */
export async function summarizeConversation(title, messages) {
  const model = await ollamaModel();

  if (model) {
    const transcript = messages.slice(-80).map(m => `${m.from}: ${m.body}`).join('\n');
    const prompt =
`You are the memory engine of a communication app. Summarize this conversation titled "${title}".
Return short markdown with sections (omit empty ones):
**Summary** (2-3 sentences) · **Decisions** · **Promises & deadlines** · **Open questions** · **Ideas**

Conversation:
${transcript}

Summary:`;
    try {
      const text = await ollamaGenerate(model, prompt);
      if (text) return { engine: 'ollama:' + model, text };
    } catch { /* fall through to heuristic */ }
  }

  // ---- transparent heuristic fallback --------------------------------------
  const pick = type => messages.filter(m => m.signals?.some(s => s.type === type));
  const promises = pick('promise'), decisions = pick('decision'), ideas = pick('idea');
  const questions = pick('question').slice(-3);
  const urgent = messages.filter(m => m.priority === 'critical' || m.priority === 'important').slice(-4);

  const bullet = (arr, prefix = '') => arr.slice(-4).map(m => `- ${prefix}**${m.from}**: ${m.body.slice(0, 140)}`).join('\n');
  const parts = [];
  parts.push(`**Summary** — ${messages.length} messages between ${[...new Set(messages.map(m => m.from))].join(', ')}.`);
  if (urgent.length) parts.push(`**Needs attention**\n${bullet(urgent)}`);
  if (promises.length) parts.push(`**Promises & deadlines**\n${bullet(promises, '🤝 ')}`);
  if (decisions.length) parts.push(`**Decisions**\n${bullet(decisions, '✅ ')}`);
  if (questions.length) parts.push(`**Open questions**\n${bullet(questions, '❓ ')}`);
  if (ideas.length) parts.push(`**Ideas**\n${bullet(ideas, '💡 ')}`);
  if (parts.length === 1) parts.push('_Nothing signal-worthy yet — just conversation._');

  return { engine: 'heuristic', text: parts.join('\n\n') };
}

/**
 * Judge a Rizz Battle: two people answer the same scenario, smoothest wins.
 * Local Ollama when it's around; otherwise an honest heuristic whose verdict
 * SHOWS the point breakdown — no pretending an if-statement has taste.
 * Returns { engine, winner: 'A'|'B', verdict }.
 */
export async function judgeRizz(scenario, lineA, lineB) {
  const model = await ollamaModel();
  if (model) {
    const prompt =
`You judge a "rizz battle": two people answer the same flirting scenario; the smoothest, most original line wins.
Scenario: ${scenario}
A: ${lineA}
B: ${lineB}
Reply with EXACTLY one line — the winning letter, a dash, then one short playful sentence explaining why. Example:
A - called back the scenario and asked a real question, B recycled a pickup line.`;
    try {
      const text = await ollamaGenerate(model, prompt);
      const m = text?.trim().match(/\b([AB])\b/);
      if (m) {
        const verdict = text.replace(/^[^-–—]*[-–—]\s*/, '').trim().slice(0, 240) || text.trim().slice(0, 240);
        return { engine: 'ollama:' + model, winner: m[1], verdict };
      }
    } catch { /* fall through to the heuristic */ }
  }

  // ---- transparent heuristic ------------------------------------------------
  const scenarioWords = new Set(scenario.toLowerCase().split(/[^a-z']+/).filter(w => w.length > 3));
  const score = raw => {
    const line = String(raw || '').trim();
    const words = line.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    const why = [];
    let pts = 0;
    if (line.length >= 20 && line.length <= 160) { pts += 2; why.push('effort without an essay'); }
    if (/\?/.test(line)) { pts += 2; why.push('asks instead of announces'); }
    if (words.some(w => scenarioWords.has(w))) { pts += 2; why.push('calls back the scenario'); }
    if (words.length >= 6 && new Set(words).size / words.length > 0.8) { pts += 1; why.push('no recycled words'); }
    if (/\p{Extended_Pictographic}|—|…/u.test(line)) { pts += 1; why.push('flair'); }
    if (/\b(hey+|wyd|u up|sup|send pics?|ur hot)\b/i.test(line)) { pts -= 2; why.push('cliché penalty'); }
    const letters = line.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) { pts -= 1; why.push('shouting'); }
    return { pts, why };
  };
  const a = score(lineA), b = score(lineB);
  // Ties go to the one who was challenged — you picked this fight, prove it.
  const winner = a.pts > b.pts ? 'A' : 'B';
  const part = (tag, s) => `${tag}: ${s.pts} pt${s.pts === 1 ? '' : 's'} (${s.why.join(', ') || 'flat delivery'})`;
  return { engine: 'heuristic', winner, verdict: `${part('A', a)} · ${part('B', b)}${a.pts === b.pts ? ' · tie goes to the challenged' : ''}` };
}
