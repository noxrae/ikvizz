# Deploying Ikvizz (free) — get a public URL

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
after a nap takes ~30–60s to wake. Data resets on redeploy (see `COSTS.md` for
the cheap persistent-disk upgrade that fixes this).

---

## Option B — Railway / Fly.io / any Docker host
The included `Dockerfile` works anywhere. On Railway: **New Project → Deploy from
GitHub repo** → it auto-detects the Dockerfile. Free trial credit applies; check
their current free allowance against `COSTS.md`.

---

## Optional environment variables (all optional)
The app runs fully standalone with **none** of these. Add them in the host
dashboard only if you want the extra features:

| Var | Purpose |
|---|---|
| `JWT_SECRET` | Set automatically by `render.yaml`. Keeps logins valid across restarts. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Optional cloud mirror/sync. |
| `GOOGLE_CLIENT_ID` | Optional Google sign-in. |

---

## Local test of the production image (optional)
If you have Docker installed, you can verify the exact deploy build locally:

```bash
docker build -t ikvizz .
docker run -p 4321:4321 ikvizz
# open http://localhost:4321
```
