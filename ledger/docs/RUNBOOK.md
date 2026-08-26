# Runbook

What to do when something goes wrong, and the four things only you can do.

---

## Your four jobs

Everything else is automated. These are not.

| | What | When |
|---|---|---|
| 1 | **Export a ZIP backup to your own drive** | Monthly. The app will nag you |
| 2 | **Check the backup light is green** | Whenever you open the app. Red banner = look at it |
| 3 | **Restore drill** — wipe a test copy, restore it, confirm nothing is missing | Every 3 months |
| 4 | **Keep your keys safe** — password, authenticator key, backup encryption key | Once, then leave them alone |

Job 1 is the one that matters most. Your nightly backups and your screenshots both live on Cloudflare. If Cloudflare disappeared, your monthly export is the only copy outside it. Treat it like a bill.

Job 3 is the one everyone skips. Every data-loss story follows the same shape: the backup existed, nobody ever restored from it, and it turned out not to work. A backup you have never restored is a guess.

---

## Where your keys live

| Key | Where it should be | What happens if you lose it |
|---|---|---|
| Supabase password | Password manager | Reset by email |
| Database password | Password manager | Regenerate in dashboard |
| Backup encryption key | Password manager **and** on paper, offline | Every encrypted backup is unreadable |

Two locations each, at least one offline. The backup key is the highest-stakes item on this list — it is the one that cannot be reset, regenerated, or emailed to you.

(If you switch two-factor on later, its recovery key joins this table — same rule, two locations.)

Also: make sure your Supabase account email is one you actually read. It is how you find out the project is about to pause.

---

## "My project is paused"

You'll get an email first. Sign in to Supabase, open the project, click **Restore**. Back in a few minutes with everything intact.

Do it within 90 days. After that the one-click restore goes away and it becomes a manual job. Longer still and the project is removed.

Meanwhile the app keeps working — you can still log trades on your phone, they just queue until the database is back.

**If it paused, the keep-alive failed.** Check GitHub → Actions for a red run before moving on.

---

## "I can't sign in"

**Wrong password** → reset by email from the sign-in screen.

**Email account gone too** → reset the password directly from the Supabase dashboard.

**Everything gone** → restore your most recent ZIP export into a fresh project. This is the scenario job 1 exists for.

---

## "I deleted something by accident"

Nothing is really deleted. Everything is marked deleted and restorable from **Settings → Trash**.

For a bad edit rather than a deletion, open the trade → **History** tab. Every change is there with a one-tap revert. That works even for something you changed months ago.

---

## Full recovery — Supabase is gone or broken

Target: back up and running in under 4 hours.

1. Make a new Postgres — Supabase, or anywhere else. It's plain Postgres, so anywhere works
2. Run the migrations from this repo
3. Get your latest backup from Cloudflare R2, decrypt with your backup key
4. Import it. Check the record counts match what the backup says
5. Restore the screenshots, verify the file checksums
6. Point the app at the new database and sign in
7. Spot-check ten trades against what you remember

Practise this every 3 months on a throwaway project. Time it. If it takes longer than 4 hours, something in the plan needs fixing.

---

## Quarterly checklist

- [ ] Restore drill completed and timed
- [ ] Monthly exports actually happened (check all 3)
- [ ] Backup light green, latest backup verified
- [ ] Keep-alive workflow green
- [ ] Both key locations still accessible
- [ ] Storage headroom: R2 under 10 GB, database under 500 MB
- [ ] Signed in on every device you still use; removed any you don't
