# 🜁 IKVIZZ

> **Communication should transfer understanding, not messages.**

IKVIZZ is not another chat app. It is **one core intelligence with four worlds**
— a working MVP of the Project IKVIZZ vision, running 100% locally on your machine.

```
                        IKVIZZ CORE
        (Memory · Relationships · Context · Brain · Search)
                             │
        ┌──────────┬─────────┼──────────────┐
        ▼          ▼         ▼              ▼
   🜁 IKVIZZ NOW  🎓 EDU   🏠 LIFE      🌠 HORIZON
   (universal)  (students) (everyone)  (spatial universe)
```

Switch worlds from the top of the sidebar. Same brain, same data, same memory —
only the presentation changes.

## The four worlds

**🜁 NOW — Universal Communication OS.** Daily Briefing, relationship graph,
living galaxy of people, Living Spaces, memory — and a chat experience built
for understanding:
- **Replies** with quoted context (click a quote to jump back, with a glow)
- **Reactions** in the IKVIZZ icon language (heart, flame, check, bulb, smile, star)
- **Edit & remove** your messages — edits are honestly re-read by the brain
  (priority and promises stay truthful) and marked "edited"
- **Voice notes** recorded in-app, stored locally like any attachment
- **Smart replies** — rule-based suggestions from the brain's signals
  (a question suggests answers; a critical message suggests "On it right now")
- **Day dividers**, **"Seen" receipts**, live links, per-conversation **drafts**
  that survive navigation, and a **scroll-to-bottom pill** that counts new
  arrivals while you're reading history
- An **aurora surface**: soft radial light behind the conversation, asymmetric
  gradient bubbles, a calm pill composer — designed to be soothing, not loud

**🎓 EDU — Student Intelligence OS.** No folders, no subjects — a **Knowledge
Universe** where every concept is a planet. Mastery = brightness, and it decays
(τ = 40 days) so dimming planets tell you what to review. Ships with a
**Knowledge Gap Detector** (“You're working on Derivatives, but Limits is at
9% — shore it up first”), a daily study plan (fix a gap → restore a dim planet
→ push a strength to mastery), and prerequisite links drawn between planets.
Plus the **Exam Simulator** — timed recall under pressure that predicts likely
mistakes from weak prerequisites and forecasts when each concept drops below
40% (blanks honestly correct the record downward) — and **Learning DNA**, a
profile of how you learn (consistency, momentum, resilience, peak hour, style),
computed transparently from your own study log.

**🏠 LIFE — Life OS.** The home screen is a **Digital Home**: Kitchen (groceries),
Bedroom (sleep), Study, Garage, Vault (documents & warranties), Money (bills),
Family, and the **Garden** — where habits literally grow (seed → sprout →
plant → tree) with streaks. Anything with a due date surfaces automatically in
the Daily Briefing. The **Crisis Predictor** watches patterns — overdue bills,
deadline clusters, withering streaks, expiring documents — and warns with a
concrete next action *before* things become emergencies. The Family room holds
your **Trusted Circles**: private shared spaces (chat + tasks + decisions) for
the people who matter, instead of public social media.

**🌠 HORIZON — the interface that doesn't exist elsewhere.** A living canvas
universe of everything you know: people are stars, concepts are planets, spaces
are galaxies, memories are diamonds, open promises are comets. Type a question
into “Ask the universe…” and **it rearranges** — matches pull into orbit around
the center and ignite, everything else recedes. Click any object to travel to it.

---

## Quick start

```bash
npm install
npm run seed     # creates a living demo world (optional but recommended)
npm start        # → http://localhost:4321
```

Sign in as **`aarav` / `aether123`** (also try `rahul`, `maya`, `amma`, `vikram`
in a second browser window to see real-time intent, context and priority flow
between two people).

```bash
npm test           # live socket integration suite (server must be running)
npm run test:auth  # Supabase Auth end-to-end (Milestone 3)
npm run test:cloud # Cloud Messaging mirror end-to-end (Milestone 4)
```

---

## What's inside (vision → shipped)

| Vision layer | Shipped in this MVP |
|---|---|
| **Dynamic Identity** | Personas (Personal / Professional / …). Assign one per relationship — every person sees a different version of you. |
| **Relationship Graph** | People are typed (Family, Mentor, Investor…) and orbit you in an inner/regular/outer circle. Closeness changes how much their words weigh. |
| **Memory Engine** | Hover any message → ⭐ *Remember this forever*. Full-text search over everything you ever said, saved, or decided (`Ctrl+K`). |
| **Context Engine** | Set a live context (Deep Work, Driving, Gym…) once — with per-relationship visibility (everyone / inner circle / no one). Nobody needs an explanation. |
| **Intent Engine** | Instead of "typing…", people see *thinking… / writing… / reflecting…* — inferred from lightweight edit telemetry, never keystrokes. |
| **Living Spaces** | Not chat rooms. A Space holds its chat, 💡 ideas, 📋 tasks, ✅ decisions and 🏁 milestones together. |
| **Priority Streams** | Every message is classified critical / important / interesting / normal. Only critical & important interrupt you. No notification firehose. |
| **Conversation Brain** | Promises ("I'll send it by Friday") are auto-detected, tracked, and land on your Daily Briefing until kept. Ideas and decisions are flagged in-line. |
| **Daily Briefing** | The home screen tells you: promises due, conversations waiting, ideas worth revisiting, open tasks — not an inbox. |
| **Relationship Map** | Toggle People → *Constellation*: your people orbit you; closeness = orbit, shared history = star size, pulsing = waiting for you. |
| **Timeline** | Every relationship accumulates its story: first message, promises, memories, milestones. |
| **Local-first privacy** | One SQLite file (`data/aether.db`) you own. JWT auth, per-conversation access control, zero cloud calls. |
| **E2E Sealed Messages** | Toggle 🔒 in any DM: ECDH (P-256) + AES-GCM via WebCrypto. Ciphertext only on the server — and the brain deliberately goes blind: no classification, no signals, no search index. What humans encrypt, no AI reads. |
| **Media sharing** | 📎 images and files in any chat — stored locally in `data/uploads`, images preview inline. |
| **✨ Catch me up** | AI summary of any conversation or space: decisions, promises, open questions, ideas. Uses a real local LLM if [Ollama](https://ollama.com) is running; otherwise a transparent signal-based summary, honestly labeled. Either way nothing leaves the machine. |

### The Brain is honest
Everything "smart" in v0 is **transparent local heuristics** (`server/brain.js`)
— deterministic, explainable, private. Every function there is a seam where an
open-weight model (Ollama / Llama / Qwen) can slot in later without changing a
single caller:

```
classifyPriority(text, closeness) → priority stream
detectSignals(text)               → promise | idea | decision | question
buildBriefing(userId)             → the daily home screen
inferIntent(telemetry)            → thinking | writing | reflecting
```

---

## Architecture

```
server/
  index.js    Express + Socket.IO on one port
  db.js       node:sqlite (built into Node ≥22.5) + schema + FTS5
  brain.js    the transparent heuristics engine (AI seam)
  core.js     domain actions: sending = classify + extract + timeline + index
  cloud.js    Milestone 4: outbox-driven mirror of core messaging → Supabase
  worlds.js   EDU (concepts, gaps, assignments, flash cards) · LIFE (rooms,
              habits, goals) · HORIZON
  notify.js   notification center: mention/reaction/call/story + live + push
  push.js     Web Push from the RFCs (VAPID + aes128gcm), zero deps, no APNs
  ai.js       Ollama auto-detect + honest heuristic fallback
  auth.js     JWT + bcrypt (Supabase Auth wired behind this seam)
  supabase.js Supabase Auth token verification (Milestone 3)
  routes.js   REST API
  sockets.js  presence, intent, live messages, reads, group-call rooms
  seed.js     demo world (relationships, space, knowledge universe, home)
public/       hand-crafted SPA — no framework, no build step
  js/icons.js custom IKVIZZ icon system: ~60 hand-drawn stroke icons, no OS emojis
  sw.js       service worker: background push delivery + click-to-open
tests/        live integration suites (145 checks: test · test:auth · test:cloud)
data/         your entire universe in one file (never commit)
```

## How data is stored (and why)

**Today: SQLite** — Node's built-in `node:sqlite` driver, one file at
`data/aether.db`. This is a deliberate local-first choice, not a shortcut:

| Layer | Now (local-first) | At scale (the seam is ready) |
|---|---|---|
| Relational data | SQLite (WAL mode) | Supabase Postgres — **core messaging already mirrors there live (Milestone 4)** |
| Full-text search | SQLite FTS5 | OpenSearch / Qdrant embeddings |
| Files & media | `data/uploads/` on disk | Supabase Storage — **attachments & story media already mirror (Milestone 4)** |
| Cache & presence | in-process maps | Redis |

Your data is genuinely yours: **Me → Export my universe** downloads everything
(messages, relationships, memories, promises, spaces, timeline) as one JSON —
locked time capsules stay sealed even in the export.

## Sign in with Supabase (Milestone 3)

Supabase is now the identity provider — email + password accounts live in
`auth.users`, while IKVIZZ stays local-first for everything else. The wiring
is the same seam Google uses, with zero new dependencies:

1. Client speaks GoTrue's REST API directly (`/auth/v1/signup`,
   `/auth/v1/token?grant_type=password`) — sign-up sends your chosen
   username/name/phone as `user_metadata`, and a Postgres trigger
   (`supabase/schema3-auth.sql`) turns it into a `public.profiles` row.
2. Server verifies the Supabase access token **properly and locally**: fetches
   the project JWKS, checks the ES256 signature with node crypto, validates
   issuer / audience / expiry (`server/supabase.js`). Legacy HS256 projects
   fall back to asking GoTrue itself.
3. A verified token is exchanged at `POST /api/auth/supabase` for a normal
   local IKVIZZ JWT — sockets, middleware, everything downstream unchanged.

Enable it in `.env` (the `NEXT_PUBLIC_*` spellings from the dashboard work too):

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
```

Then on the auth screen: **email → Supabase, username → local.** New accounts
register with email through Supabase (confirmation emails and all); the demo
accounts (`aarav`…) keep signing in locally, untouched. An old local account
with the same email is linked on first Supabase sign-in, never duplicated.

Apply the schema with `npm run migrate` (or paste `supabase/schema.sql` +
`supabase/schema3-auth.sql` into the SQL editor), and test the full loop —
admin-minted confirmed user → password grant → token exchange → `/api/me` —
with `npm run test:auth` (needs `SUPABASE_SERVICE_KEY` in `.env`).

## Core Messaging in the cloud (Milestone 4)

Every core-messaging write now mirrors into the Supabase schema from
Milestones 1–2 — DMs, Living-Space group chats, replies, edits, deletes,
reactions, poll votes, read markers, moments (stories) and media — while the
app stays 100% local-first: SQLite remains the source of truth and nothing
ever waits on the network.

How it works (`server/cloud.js`, zero new dependencies):

1. **Outbox, not RPC.** Each local write drops an idempotent *sync current
   state* item into a `cloud_outbox` table (coalesced, so ten edits of one
   message are one sync). A background flusher pushes items into Supabase
   Postgres over the `pg` driver; failures back off and retry forever —
   nothing is dropped silently, and a crash just resumes where it left off.
2. **Stable identities.** Rows are keyed by uuids minted locally, so retries
   and concurrent flushers can never duplicate data. Real Supabase accounts
   link via the `supabase_id` column from Milestone 3; local-only users (the
   demo accounts) lazily get a **shadow identity** in Supabase Auth
   (`aarav@shadow.aether.invalid`, minted via the admin API) so every foreign
   key holds. Shadow passwords are random and never used — sign-in stays local.
3. **Media follows.** Attachments and story images upload to the private
   `media` Storage bucket (created automatically) with an `attachments` row
   pointing at them; deleting a message removes its cloud media too.
4. **Honesty travels.** Sealed messages mirror as ciphertext with `[]`
   signals — the cloud learns nothing the local server couldn't read. Time
   capsules keep their `unlock_at`. Deletes become tombstones (`deleted`,
   empty body), exactly like local.

```
npm run cloud:backfill   # push the existing local universe into Supabase once
npm run test:cloud       # live end-to-end proof (20 checks against real Supabase)
```

Requires `SUPABASE_DB_URL` (+ `SUPABASE_SERVICE_KEY` for shadow identities
and Storage) in `.env`. Without them the mirror is off and IKVIZZ behaves
exactly as before.

## Sign in with Google

Fully wired (Google Identity Services on the client, RS256 ID-token
verification against Google's JWKS on the server — zero extra dependencies).
Enable it in two minutes:

1. [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
   → Create OAuth client → **Web application** → authorized JavaScript origin
   `http://localhost:4321`
2. Start the server with the ID:
   `$env:GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"; npm start`

The auth screen then shows the official Google button. First-time Google users
get an account automatically (username derived from their email, Google photo
as avatar); an existing account with the same email is linked, not duplicated.
Until configured, the button explains exactly this — no fake flows.

### Design system
The entire UI uses a single hand-drawn icon language (24×24 grid, 1.8px round
strokes, `currentColor`) defined in `public/js/icons.js` — nothing depends on
the OS emoji font, so IKVIZZ looks identical and intentional on every machine.
User-created things (spaces, personas, concepts) choose from curated on-brand
icon sets rather than free-form emoji.

**Deliberate MVP choices:** no Postgres/Redis/MinIO/Keycloak yet — those are
scale-out tools. Every one of them has a clean seam here for Phase 5.

## The phase build-out (what shipped beyond the MVP)

Working through the original phase plan, category by category — free tier only,
and deliberately **no Apple/iOS integrations** (no APNs; Safari users rely on
the in-app center):

- **Group chat, complete** — space roles (owner / admin / member: only
  owner+admins invite or remove, only the owner grants admin), **pinned
  messages** (a strip above any chat, DM or space, 10 max), and a **Files**
  tab: every attachment ever shared, one wall.
- **Calls, complete** — 1:1 voice/video/screen-share already existed; now
  **group calls in Living Spaces**: mesh WebRTC (one peer connection per
  member, newcomer initiates — no glare), live head-count on the chat header,
  join/leave announced. The server still only relays handshakes.
- **Moments, five voices** — text · photo · **video** · **voice** (recorded
  in-composer) · **music** (drop an mp3). All 24h, all scope-aware, all
  mirrored to Supabase Storage.
- **Notifications, honest** — a quiet **notification center** (mentions,
  reactions to your messages, missed calls, new moments) with an Alerts bell;
  Priority Streams still decide what interrupts. Plus **real Web Push**
  implemented from the RFCs in ~100 lines of node:crypto (VAPID ES256 +
  aes128gcm payload encryption) — Chrome/Edge/Firefox/Android, sent **only
  when you're away**, because pushing to someone who's already here is noise.
- **Context Search** — the Ctrl+K palette grew lenses: everything / messages /
  memories / space items / **this chat**.
- **Student mode, deeper** — **assignments** (deadlines land on the Daily
  Briefing), **flash cards** (grading a card is a half-weight study session on
  its concept — same honest mastery machinery), **study rooms** (Living Spaces
  born for studying: notes & questions tabs).
- **Life OS, wider** — **Health** and **Travel** rooms, and **Goals**: long
  arcs with human-moved progress bars, watched by the Crisis Predictor when a
  deadline nears with most of the road ahead.

## Roadmap seams already in the code

- `brain.js` → swap heuristics for Ollama models (Phase 4: Intelligence Layer)
- `ai.js` → already auto-detects Ollama for summaries; extend to briefings & search
- `fts` table → swap for Qdrant/Chroma embeddings (Phase 2: semantic search)
- `auth.js` → Supabase Auth now wired behind this seam (Milestone 3); Keycloak still possible for self-hosted deployments
- `cloud.js` → core messaging mirrors to Supabase (Milestone 4); Milestone 5 (IKVIZZ Intelligence: promises, memories, knowledge graph in the cloud + Supabase Realtime for multi-device) rides the same outbox
- `signals` JSON column → grows into the Knowledge Graph

### E2E honesty notes (v0)
- Sealed messages use ECDH P-256 + AES-GCM per DM pair. The private key lives in
  this browser's localStorage — clear it (or switch devices) and old sealed
  messages become unreadable there. Multi-device key sync (libsignal/MLS-style)
  is the next milestone.
- Group/space sealing is not offered yet (pairwise keys only).
- Regular (unsealed) messages stay readable by the local brain **by design** —
  that's what powers priority, promises and search. The 🔒 toggle is the user's
  explicit choice of privacy over intelligence, per message.
