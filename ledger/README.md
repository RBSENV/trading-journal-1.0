# Ledger

Private trading journal. Manual capture, offline-first, built so records survive
device loss, browser eviction, and vendor failure.

**Start here:** [`docs/SETUP.md`](docs/SETUP.md) — 3 steps, no CLI · **When something breaks:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

## Stack

| | |
|---|---|
| App | React + TypeScript + Vite, installed as a PWA |
| Database | Supabase Postgres, row-level security on all 26 tables |
| Auth | Supabase Auth, email + password (TOTP optional) |
| Media | Cloudflare R2 via a signed-URL Worker *(Stage 5)* |
| Backups | Worker cron → encrypted → R2, verified *(Stage 4)* |
| Hosting | Cloudflare Pages |

Runs at $0/month.

## Design rules

1. **Local storage is a cache, never the record.** WebKit can clear it without warning.
2. **RLS ships in the same migration as the table it protects.** Never separately.
3. **The audit trail is written by database triggers.** The client cannot skip or forge it.
4. **Nothing hard-deletes.** Everything is soft-deleted and restorable.
5. **No P/L is ever computed from fills.** Final dollars and percent are typed by hand.
6. **All times display in America/New_York.** Event times are editable; record times are not.
7. **A status indicator never lies.** "Synced" is not shown while anything is pending.

## Repo rules

Source code only. Trades, journal text, screenshots, exports, backups and
credentials never enter this repository. CI blocks them and secret scanning runs
on every commit.

## Stages

| | | |
|---|---|---|
| 1 | Foundation and security | **done** |
| 2 | Sync engine | **done** |
| 3 | Trades, legs, timeline | **done** |
| 4 | Export, import, backups, restore drill | |
| 5 | Media | |
| 6 | Daily prep | |
| 7 | Search and review | |
| 8 | Audit and conflict UI | |
