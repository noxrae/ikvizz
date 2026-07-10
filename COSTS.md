# IKVIZZ — Cost Sheet (resources & what they cost)

> **Rule reminder:** nothing here that costs money will ever be turned on without
> asking you first. The default deploy below is **$0**. Everything in the "Paid"
> section is *optional* — you only pay if you decide you need it.

_Last updated: 2026-07 · prices are indicative and can change with each provider._

---

## ✅ Free — the whole app runs at $0

| Resource | How it's free | Notes / limits |
|---|---|---|
| **Hosting (Render free web service)** | Free plan, no card needed to start | Sleeps after ~15 min idle → first visit after sleep takes ~30–60s to wake ("cold start"). 750 free instance-hours/month. |
| **HTTPS / SSL certificate** | Auto-provisioned by the host | Required for PWA install — included free. |
| **The `*.onrender.com` URL** | Given free with the service | e.g. `https://ikvizz.onrender.com`. |
| **App itself (Node + Socket.IO + SQLite)** | Self-contained, no paid services | Local SQLite file, zero external dependencies. |
| **PWA install (Add to Home Screen)** | Web standard | No Apple/Google app-store fees, no developer accounts. |
| **Web Push notifications** | Self-hosted VAPID keys | Free at normal volumes. |
| **Google Sign-in** (optional) | Google OAuth is free | Only needs a free Google Cloud project if you enable it. |
| **Durable persistence (Supabase Storage)** | Snapshots data + media to Supabase, restores on boot | **Free tier** (1 GB storage / 500 MB DB). Data survives redeploys & sleep. Free projects pause after ~7 days idle (one click to reopen). See `DEPLOY.md` §4. |

**Data is now durable on free tier** once you set `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (see `DEPLOY.md` §4): the whole database + uploaded media are snapshotted to Supabase Storage and restored after every redeploy/sleep — at **$0**. Without those vars set, the free disk is ephemeral (resets on redeploy) — fine for a throwaway demo.

---

## 💳 Paid — optional, only if/when you want it

| Upgrade | Why you'd want it | Rough cost |
|---|---|---|
| **Persistent disk** (Render Disk) | Alternative to free Supabase persistence — keeps data on a local disk (lower latency, no 7-day pause) | ~**$0.25 / GB / month** (e.g. 1 GB ≈ $0.25/mo) — *optional; the free Supabase snapshot above already makes data durable* |
| **Always-on instance** (Render Starter) | Kill the cold-start delay; app never sleeps | ~**$7 / month** |
| **Custom domain** (e.g. `ikvizz.com`) | Your own brand URL instead of `*.onrender.com` | Domain: ~**$10–15 / year** from a registrar (Namecheap/Cloudflare). HTTPS on it is still free. |
| **Supabase cloud sync** (optional mirror) | Multi-device sync / cloud backup of data | **Free tier** (500 MB DB, limits). Pro ~**$25/mo** only if you exceed it. |
| **More RAM / CPU / scaling** | Many concurrent users, heavier load | Varies by plan (Render Standard ~$25/mo+) |
| **Bandwidth over the free allowance** | Very high traffic | Overage billed per-GB by the host |
| **Managed Postgres** (instead of SQLite) | Serious multi-user durability at scale | Render/Supabase/Neon free tiers exist; paid from ~$7–19/mo |

---

## Recommended path

1. **Now / to share with users:** deploy on the **free** plan (see `DEPLOY.md`). $0, live URL, installable.
2. **Make data permanent — free:** set `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (DEPLOY.md §4). Data survives redeploys & sleep at $0. *(This is the current setup.)*
3. **When you want it always-instant + your own domain:** Starter plan (~$7/mo) + a domain (~$12/yr).

I'll never enable any of the paid items without checking with you first.
