# Setting up nightly backups

About 20 minutes, one time. After this it runs on its own.

Order matters — generate the key first, because the worker needs it.

---

## 1 — Generate your backup key

In the app: **Sync** (bottom right) → **Backup & restore** → **Generate a key pair**.

You get two keys.

**Public key** (`ledger-pk-…`) — goes into the worker. Harmless if seen. It can
lock backups and cannot open them.

**Private key** (`ledger-sk-…`) — the only thing that can read your backups.

**Save the private key in two places before leaving that screen:**
- Your password manager
- Printed on paper, somewhere physical

It is shown once. Lose it and every encrypted backup is permanently unreadable —
by you, by me, by anyone. There is no reset. That is the same property that makes
it worth having: it means Cloudflare is storing files it cannot open.

---

## 2 — Make the R2 bucket

Cloudflare → **R2** → **Create bucket** → name it `ledger-backups`.

Leave everything default. 10 GB free, no egress charges, which is roughly a
decade at your volume.

---

## 3 — Get your service key from Supabase

Supabase → **Settings** → **API Keys** → the **secret** / **service_role** key.

This one is different from the publishable key you used before. **It reads every
row and ignores every lock.** It goes into Cloudflare's secret storage and
nowhere else — never in GitHub, never in the app, never in a `.env` you commit.

---

## 4 — Deploy the worker

On your Mac, in the `workers/backup` folder:

```bash
npm install
npx wrangler login
npx wrangler secret put SUPABASE_SERVICE_KEY   # paste the service key
npx wrangler secret put BACKUP_PUBLIC_KEY      # paste ledger-pk-…
npx wrangler deploy
```

It prints a URL like `ledger-backup.oginflict.workers.dev`.

---

## 5 — Point the app at it

Cloudflare → **Pages** → your project → **Settings** → **Environment variables** →
add:

```
VITE_BACKUP_WORKER_URL = https://ledger-backup.YOUR-SUBDOMAIN.workers.dev
```

Redeploy. The Backup screen now shows a green line after each night's run and a
red one if a night is missed.

---

## 6 — Prove it works

This is the step people skip, and skipping it is exactly how you end up with a
year of backups that turn out not to work.

1. Wait for the first nightly run, or trigger one manually
2. Cloudflare → R2 → `ledger-backups` → download the newest `.enc` file
3. App → **Backup & restore** → paste your private key → choose that file
4. It should decrypt and show you a row count that matches your data

If step 4 works, you have a real backup. If it doesn't, better to find out now
than in February. **Do this once a quarter.**

---

## What runs each night at 3am ET

1. **Keep-alive** — one request, so Supabase never idles your free project out
2. **Snapshot** — every row, including your trash, encrypted with your public key
3. **Verify** — read back out of R2 and hash-checked against what was written
4. **Prune** — 7 daily, 8 weekly, 12 monthly, every yearly kept forever

Step 3 is the difference between a backup and a hope. A file that has never been
read back only proves that an upload returned success.

---

## Where your copies live

| | What | Where |
|---|---|---|
| 1 | Live database | Supabase |
| 2 | Nightly encrypted snapshots | Cloudflare R2 |
| 3 | Monthly manual export | **Your own disk** |

Layer 3 is not optional. Layers 1 and 2 are both cloud vendors; layer 3 is the
only copy that survives losing an account. Once a month, **Backup & restore** →
**Save a backup file now** → put it somewhere real.
