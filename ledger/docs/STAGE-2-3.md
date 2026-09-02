# Stages 2 & 3 — what changed

Two things to do, then it's live.

---

## 1 — Run the new SQL

Supabase → **SQL Editor** → **New query** → paste `STAGE-2-RUN-IN-SUPABASE.sql` → Run.

Adds the sync machinery: a change counter, the upload/download functions, and
conflict tracking. Doesn't touch anything you already have.

## 2 — Update the code

Delete the old `ledger` folder from GitHub, upload the new one, commit.
Cloudflare rebuilds on its own.

---

## What you can do now

**Log a trade.** Tap `+`. Symbol and direction are the only required fields —
everything else can wait until the position isn't moving.

**Update an open trade.** Tap `+ Update` on the card. Ten actions, two taps
each: add, partial exit, move stop, move target, note, mistake, thesis, news,
observation.

**Close it out.** Final price, your P/L, and the MAE/MFE off the chart. It
computes R-multiple and exit efficiency as you type.

**It works with no signal.** Every save lands on your phone first and uploads
later. The dot bottom-right tells you which state you're in and never says
"Synced" while anything is waiting. Tap it to see exactly what's queued.

---

## Worth knowing

**Editing a leg doesn't overwrite it.** It writes a new version and keeps the
old one. Your edit history is real, not a claim.

**Two devices won't fight.** Notes and events are separate records, so adding
one on your phone and another on your Mac just gives you both. If you edit the
same *field* in two places, the app keeps both versions and asks you — it never
picks silently.

**It checks your numbers against each other.** If your P/L is bigger than the
best move that was available, that's flagged at close-out while the chart is
still in front of you. Three numbers, one of them wrong, and no way to tell
which a year later.

**Nothing deletes.** Everything is recoverable.

---

## Test it yourself

Worth five minutes before you trust it with a real trade:

1. Log a trade, force-quit the app, reopen → still there
2. Airplane mode, add three notes → chip says `Offline · 3`
3. Turn signal back on → goes `Syncing` then `Synced`
4. Open it on your Mac → same trade, same notes
5. Add a note on the Mac, refresh the phone → it appears

If any of those fail, tell me which one.

---

## Next: Stage 4

Export and backup. Your data becomes a file you can hold — and the analysis
export that goes into a chat.
