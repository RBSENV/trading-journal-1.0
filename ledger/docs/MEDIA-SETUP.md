# Setting up screenshots

10 minutes. Do this after the backup worker — same pattern, simpler.

Screenshots go to Cloudflare R2 rather than Supabase because Supabase's free
tier gives you 1 GB, which is roughly twelve months at five charts per trade.
R2 gives you 10 GB with no charge for viewing them, which is closer to a decade.

---

## 1 — Make the bucket

Cloudflare → **R2** → **Create bucket** → name it `ledger-media`.

Separate from `ledger-backups` on purpose: different lifecycles, and you never
want a backup retention rule reaching into your live images.

---

## 2 — Deploy the worker

On your Mac, in `workers/media`:

```bash
npm install
npx wrangler secret put SUPABASE_ANON_KEY   # the publishable key, same as the app
npx wrangler deploy
```

Note what this worker does **not** get: the service key. It checks who you are;
it never reads your database. Smallest possible blast radius if it were ever
compromised.

---

## 3 — Point the app at it

Cloudflare → **Pages** → your project → **Settings** → **Environment variables**:

```
VITE_MEDIA_WORKER_URL = https://ledger-media.YOUR-SUBDOMAIN.workers.dev
```

Redeploy.

---

## How it behaves

Open a trade → **Charts** → **+ Add**.

From your iPhone you get the Photos picker. On a Mac you can also just paste an
image straight from the clipboard.

Then stage (before entry / entry / during / partial / final / after), timeframe,
caption, and a context note.

**The context note is worth more than it looks.** You can't paste forty
screenshots into a chat, so that field is what carries the chart into an
analysis as text. *"Range looks clean but volume is half the morning, which I
didn't check"* gets read. The image doesn't.

---

## What happens when you attach one

1. Saved to your phone immediately, shown right away marked **saved locally**
2. Uploaded in the background
3. The worker hashes what it received and the app compares it to what it sent
4. Only on a match does the local copy become disposable

Which means: attach a chart in a lift, close the app, restart the phone — it's
still there and it still uploads when you get signal.

**An unsent image is never evicted from your phone**, no matter how full storage
gets. If space runs out with media still waiting, the app refuses new attachments
rather than quietly dropping a screenshot that exists nowhere else.

---

## Two iOS things I handled

**HEIC.** The app never asks for `image/heic`. Safari 17+ has a bug where
listing it causes iOS to convert your *other* formats *into* heic — a PNG goes
in and a `.heic` comes out. Asking only for jpeg/png/webp makes iOS hand over a
normal JPEG.

**Missing timestamps.** iOS usually strips the original capture time during that
conversion. So the capture time defaults to now and is always editable — same as
every other timestamp in the app. Never trust EXIF; type what you know.

---

## Worth doing once

Turn on airplane mode. Attach a screenshot to a trade. Force-quit the app.
Reopen it — the image is still there, marked *saved locally*. Turn signal back
on and watch it upload.

That's the test that matters. If that works, a chart you attach is a chart you
still have.
