# Setup

Three steps. No command line. About 15 minutes.

---

## 1 — Make the database (10 min, all in your browser)

**a.** Go to supabase.com → sign up → **New project**

Name it `ledger`, pick the region nearest you, leave it on **Free**. Save the
database password it gives you — you won't see it again.

Wait ~2 minutes for it to finish setting up.

**b.** Left sidebar → **SQL Editor** → **New query**

Open `RUN-THIS-IN-SUPABASE.sql`, copy the whole thing, paste it in, hit **Run**.

That's your entire database. One paste.

**c.** Left sidebar → **Authentication** → **Users** → **Add user** → **Create new user**

Your email, a password you'll remember, and tick *Auto Confirm User*.

**d.** Left sidebar → **Settings** → **API**

Copy these two somewhere you can reach in a minute:
- **Project URL**
- **anon public** key

Both are fine to have in the app. The database checks who's asking on every
query and only ever returns your own rows.

---

## 2 — Put the app online

Same as your other apps. Push this folder to a private GitHub repo, then:

**Cloudflare** → **Workers & Pages** → **Create** → **Pages** → connect the repo.

When it asks:
- Build command: `npm run build`
- Output directory: `dist`

Then **Settings → Environment variables**, add the two values from step 1d:

```
VITE_SUPABASE_URL       = your Project URL
VITE_SUPABASE_ANON_KEY  = your anon key
```

Deploy. You get a URL.

---

## 3 — Put it on your phone

Open that URL in Safari → **Share** → **Add to Home Screen**.

Do it this way rather than leaving it as a tab. From the Home Screen your
offline data sticks around; in a tab, Safari can wipe it after a week unused.

Sign in with the email and password from step 1c.

---

## Done

You should see an empty Today screen, a green **Synced** dot bottom-right, and
BTC, ETH, ES and NQ already set up.

---

## One thing to do this week

Supabase pauses free projects if nothing touches them for 7 days. Your data is
safe and it is one click to bring back — but easier to just prevent it.

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → add:
- `SUPABASE_URL` — your Project URL
- `SUPABASE_ANON_KEY` — your anon key

Done. It pings every 3 days on its own. Only the public key goes in there.

---

## Never put in the GitHub repo

Trades, screenshots, exports, backups, your database password. The repo blocks
these automatically, but the rule matters more than the check.
