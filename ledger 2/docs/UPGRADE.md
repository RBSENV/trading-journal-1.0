# Upgrading to stages 2–4

Two steps. Database first, then the app.

---

## 1 — Run the database upgrade

Supabase → **SQL Editor** → **New query** → paste **`UPGRADE-SYNC.sql`** → Run.

Adds the change-tracking the offline sync engine needs. It's additive — nothing
existing is dropped or rewritten.

Expect: `Success. No rows returned.`

> Only run `UPGRADE-SYNC.sql`. `RUN-THIS-IN-SUPABASE.sql` is the full setup for a
> fresh project and will error on tables you already have.

---

## 2 — Update the app

GitHub → your repo → delete the old `ledger` folder → **Add file → Upload files**
→ drag the new `ledger` folder in → **Commit changes**.

Cloudflare rebuilds on its own. Watch **Deployments** for a green row with the
new commit hash.

Then pull-to-refresh on your phone.

---

## What you get

**Offline capture.** Everything saves to your phone the instant you tap, then
uploads on its own. Airplane mode, dead signal, elevator — all fine. The dot
bottom-right tells you where things stand and never says "Synced" while
anything is still waiting.

**Trades.** Log one in about fifteen seconds: symbol, direction, price, quantity.
Add to a position, take partials, move stops, drop notes on an open trade in
about eight. Every timestamp is editable — no timers, no Start button.

**Close-out.** Enter your own P/L. If you recorded a 1R, you get the R-multiple.
MAE and MFE take thirty seconds off the chart and are the one thing you can
never reconstruct later.

**Daily prep.** Bias, structured key levels, economic events, thesis, end-of-day
review.

**Export.** The point of the whole thing. Filter, tap **Copy for analysis**,
paste into a chat. Every derived number — R-multiple, excursions in R, exit
efficiency, win rate, expectancy, profit factor, breakdowns by session and setup
and grade — is computed before it leaves, so the model reads results instead of
doing arithmetic.

**Restore.** Load a backup file. It checks the file and shows you exactly what
would happen before writing anything, and running the same file twice changes
nothing the second time.

---

## Worth trying once

Airplane mode. Log a trade. Force-quit the app. Reopen it — the trade is still
there and the dot says `Offline · 1`. Turn signal back on and watch it go green.

That's the part everything else rests on. Better to see it work now than to
wonder in February.
