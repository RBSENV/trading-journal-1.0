# Testing it

The app now has a self-test. It's the fastest way to find out whether anything
I built actually works against your setup.

**Sync dot (bottom right) → Run self-test → Run the tests.**

Takes about ten seconds. It creates its own throwaway trade, pushes it, pulls it
back, deletes it, restores it, then cleans up. Nothing you've written is touched.

---

## What it checks, and why each one matters

| Check | What breaks if it fails |
|---|---|
| Signed in | Nothing works |
| Database tables exist | The setup SQL didn't finish |
| Your data is locked to you | Anyone with the public key could read your trades |
| Change history is read-only | Your audit trail could be forged |
| Instruments loaded | Seed data missing |
| Saving works locally | A tap isn't durable before the network |
| **Uploading works** | **Your trades never leave the phone.** The big one |
| Downloading works | Edits from your Mac never reach your phone |
| **Retrying is safe** | **A flaky connection creates duplicate trades** |
| Delete and restore | Something is actually gone |
| Export builds | You can't get your data out |
| Restore validates | A damaged backup half-loads instead of being refused |
| Backup encryption | Backups can't be locked, or can't be opened |
| Screenshot storage | Charts don't upload (skipped if not set up) |
| Nightly backup | No verified backup ran (skipped if not set up) |

Two of those are worth extra attention.

**Uploading works** is the one that decides whether this is a journal or a
notepad. If it fails, the most likely cause is that `UPGRADE-SYNC.sql` hasn't
been run.

**Retrying is safe** is the subtle one. On a bad connection the app resends
things it isn't sure landed. If the server doesn't recognise a repeat, you get
two copies of the same trade — and you'd probably never notice until the numbers
looked wrong months later.

---

## If something fails

Send me the red lines. Each one shows the actual error, not a generic message.

Skipped isn't failed — it means that piece isn't set up yet, which is expected
until you do the media and backup workers.

---

## When to run it

- Once before you start logging real trades
- After any app update
- After any database change
- If something ever feels off

---

## The one it can't do for you

There's no way to automate this: **turn on airplane mode, log a trade,
force-quit the app, reopen it.** The trade should still be there and the dot
should read `Offline · 1`. Turn signal back on and watch it go green.

Two minutes, and it's the thing everything else rests on. Worth doing once,
deliberately, before you need it to work.
