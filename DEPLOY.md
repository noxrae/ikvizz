# Deploying IKVIZZ (free) — get a public URL

This gives you a live, installable `https://…` URL your users can open on any
phone/laptop, at **$0**. Takes ~5–10 minutes. Everything the host needs is
already in this repo (`Dockerfile`, `render.yaml`).

> Why you do these clicks (not me): a deploy has to sign in to **your** GitHub +
> hosting account (an interactive login I can't perform for you from here). I've
> done all the code/config prep so it's just connect-and-click.

---

## Option A — Render (recommended, simplest free path)

### 1. Put the code on GitHub
The repo is already committed locally. Create an empty GitHub repo, then:

```bash
git remote add origin https://github.com/<your-username>/ikvizz.git
git branch -M main
git push -u origin main
```

(Secrets like `.env`, `KEYS.local.md`, and the `data/` folder are already
excluded by `.gitignore`, so nothing sensitive is pushed.)

### 2. Deploy on Render
1. Go to **https://render.com** → sign up (free, GitHub login).
2. **New → Blueprint** → pick your `ikvizz` repo.
3. Render reads `render.yaml` and configures the service automatically. Click
   **Apply / Create**.
4. Wait for the first build (~2–4 min). You'll get a URL like
   **`https://ikvizz.onrender.com`**.

### 3. Share it
That URL is your app. On a phone, open it → menu → **Add to Home Screen** /
**Install** (or use the in-app **Get the app → Install** button in Settings).

**Free-tier behaviour:** the app sleeps after ~15 min idle, so the first visit
after a nap takes ~30–60s to wake. With **durable persistence** turned on (next
section), your data survives redeploys and sleep — at **$0**.

---

## 4. Make data permanent (free) — Supabase Storage

Render's free disk is wiped on every redeploy/sleep. IKVIZZ can snapshot its whole
database + uploaded media to **Supabase Storage** and restore it on boot, so
accounts, messages, memories, spaces and media all come back. Free tier, no card.

1. Go to **https://supabase.com** → create a free project (any region near you).
2. In the project: **Settings → API** → copy the **Project URL**
   (looks like `https://xxxx.supabase.co`).
3. **Settings → API Keys** → copy the **`service_role`** secret (a.k.a. the
   `sb_secret_…` / secret key). *This is a secret — never commit it.*
4. In **Render → your service → Environment**, add two variables:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SECRET_KEY` = the service_role / secret key
5. Save → Render redeploys. On boot you'll see `IKVIZZ Persist: on` in the logs.
   From now on data is snapshotted every ~90s and on shutdown, and restored
   automatically after any redeploy or wake-from-sleep.

That's it — no schema to run for this; the app manages its own private
`ikvizz-backups` bucket. (`NODE_ENV=production`, already set by `render.yaml`,
is what switches persistence on.)

**Free-tier caveats to know:**
- Supabase free projects **pause after ~7 days of no activity** — while paused,
  restores can't reach it until you reopen the project in the dashboard (one click).
- Free limits: 1 GB Storage + 500 MB Postgres — plenty for a preview/community app.
- There's a tiny window (up to ~90s, the snapshot interval) where the very latest
  messages might not yet be backed up if the server is killed hard without a clean
  shutdown. A normal Render redeploy triggers a final snapshot first.

---

## Option B — Railway / Fly.io / any Docker host
The included `Dockerfile` works anywhere. On Railway: **New Project → Deploy from
GitHub repo** → it auto-detects the Dockerfile. Free trial credit applies; check
their current free allowance against `COSTS.md`.

---

## Reliable long-distance calls (optional, free) — TURN

Voice/video calls connect peer-to-peer. Between people on the same/simple networks
that "just works", but across mobile/CGNAT networks far apart, WebRTC needs a
**TURN relay**. The app ships with a free public relay (OpenRelay) which works
*most* of the time; for rock-solid calls, plug in your own free TURN:

1. Create a free account at **https://www.metered.ca/** (TURN, 50 GB/month free).
2. In their dashboard, note your **subdomain** (e.g. `yourname.metered.live`) and **API key**.
3. In Render → **Environment**, add:
   - `METERED_DOMAIN` = `yourname.metered.live`
   - `METERED_API_KEY` = your key
4. Save → redeploy. The app now serves real TURN credentials at `/api/ice` and
   long-distance calls connect reliably. No code change needed.

## Optional environment variables (all optional)
The app runs fully standalone with **none** of these. Add them in the host
dashboard only if you want the extra features:

| Var | Purpose |
|---|---|
| `JWT_SECRET` | Set automatically by `render.yaml`. Keeps logins valid across restarts. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | **Durable persistence** — data survives redeploys (free; see section 4). |
| `GOOGLE_CLIENT_ID` | Optional Google sign-in. |

---

## Local test of the production image (optional)
If you have Docker installed, you can verify the exact deploy build locally:

```bash
docker build -t ikvizz .
docker run -p 4321:4321 ikvizz
# open http://localhost:4321
```
