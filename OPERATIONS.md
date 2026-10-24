# Solalium operations guide

Written for the day something goes wrong, and for the day before launch. Commands run from the `server` folder unless said otherwise.

## 1. Before launch: the checklist

Run these. Every one should pass.

| # | Check | How |
|---|---|---|
| 1 | Backend tests | `npm test` (224 tests) |
| 2 | Clean frontend build | in `client`: delete `node_modules` and `dist`, then `npm ci && npm run build` |
| 3 | Who can call what | `npm run e2e:security` (every endpoint with no login, with the wrong account type, and with someone else's data) |
| 4 | Paystack | `npm run e2e:security` (bad signatures, short or wrong-currency payments, failed charges, duplicates, replays, verification), then one real test-mode payment (section 3) |
| 5 | Transactions and order states | `npm run e2e` and `npm run e2e:security` (simultaneous checkouts, payments, accepts, pickups, confirmations) |
| 6 | Login, codes, resets, cookies | `npm run e2e:security` |
| 7 | Production settings | `NODE_ENV=production npm run check:env` with the same variables you set on Render |
| 8 | Customer and vendor journeys, desktop and phone | in `client`: `python3 e2e/journeys.py <api-log> <screenshots-folder>` (needs Playwright; see the top of that file) |
| 9 | Backups | section 5, including one practice restore |
| 10 | CI | push to GitHub and wait for the green tick |

## 2. Settings (Render and Vercel)

**Render (the API).** Copy `.env.example`. These matter most:

- `NODE_ENV=production`
- `CLIENT_ORIGIN=https://your-domain` (https, no trailing slash). The server refuses to start otherwise.
- `JWT_SECRET` 32+ random characters. Changing it later logs everyone out.
- `DB_*` for TiDB Cloud. SSL is automatic for any remote host.
- `PAYSTACK_SECRET_KEY` (`sk_live_...`). Without it the server refuses to start in production, so simulated payments can never be switched on by accident.
- `RESEND_API_KEY` and `MAIL_FROM` on a domain you verified in Resend (`onboarding@resend.dev` only emails you).
- `LOGISTICS_EMAIL`, `ADMIN_NOTIFY_EMAIL`, `CLOUDINARY_URL`, `VENDOR_APPROVAL_REQUIRED=1` once you verify vendors by hand.
- `TRUST_PROXY`: **2** when the site reaches Render through the Vercel `/api` rewrite, **1** if browsers call Render directly. Without it the server sees only the proxy's address, so every visitor shares one rate-limit bucket (for example 30 login attempts per 15 minutes for the whole site) and a busy hour or one attacker blocks everyone. I could not test the Vercel-to-Render chain from here, so **verify after deploy:** make about 31 wrong login attempts from your laptop, then try to log in from your phone on mobile data. If the phone is blocked too, the server is still seeing one address: raise `TRUST_PROXY` by one and try again. If you are blocked after fewer attempts than expected, lower it.

**Vercel (the site).**

- `VITE_SITE_URL=https://your-domain`: used for canonical links, the sitemap and share previews.
- `SEO_API_URL=https://your-render-app.onrender.com` (optional): lets the build list products in `sitemap.xml`. Trigger a redeploy now and then (or after adding many products) to refresh it.
- `client/vercel.json` already sends `/api/*` to Render and every other path to `app-shell.html`. If you change the Render address, change it there.

**Paystack dashboard.** Set the webhook URL to `https://<your-render-app>.onrender.com/api/webhooks/paystack` (straight to Render, not through Vercel, so the signed body arrives untouched).

Run `NODE_ENV=production npm run check:env` with your real settings. It prints what to fix and checks that the database is reachable and has the latest tables.

## 3. First real payment (test mode, then live)

1. With an `sk_test_` key, buy the cheapest product with a Paystack test card.
2. Confirm: order shows Paid, the vendor sees it, the customer and admin got emails.
3. Watch the Render logs for lines with `"status":5xx`: there should be none.
4. In the Paystack dashboard, re-send the webhook event for that payment if your dashboard offers it. The order must not change and no second email must go out (this is also covered by `npm run e2e:security`).
5. Switch to the live key and repeat once with a small real amount, then refund it.

## 4. Logs and monitoring

- Every request writes one JSON line: id, method, path (no query string), status, milliseconds, user id, IP. No bodies, cookies or passwords are logged. Errors include the same `requestId` the user sees in the error message and in the `X-Request-Id` header: ask for it when someone reports a problem, then search the Render logs for it.
- Set up a free uptime monitor (UptimeRobot, Better Stack) on `https://<your-render-app>.onrender.com/api/ready`. It returns 200 only when the database answers, 503 otherwise. Alert your phone and email.
- Render free instances sleep when idle: the first request after a quiet period is slow. A monitor pinging every 5 minutes keeps it awake, or use a paid instance before launch.
- Watch weekly: Render logs for `"level":"error"`, Paystack dashboard for failed webhooks, the admin Activity page.
- Payment problems email `ADMIN_NOTIFY_EMAIL` (for example a second payment for an order already paid is flagged for refund).

## 5. Backups and recovery

- TiDB Cloud keeps its own automatic backups. Open the cluster's Backup page and note how long they are kept on your plan and whether point-in-time restore is included. This is your main protection.
- Your own copy: `npm run db:backup` writes `backups/<db>-<time>.sql.gz` using only Node. Run it weekly and before any risky change (a schema change, a bulk edit). Store the file somewhere private and not in Git. It contains customer emails and password hashes.
- **Practise a restore.** Create an empty scratch database, point `DB_NAME` at it and run `npm run db:restore -- backups/<file>.sql.gz`. It refuses to overwrite a database that already has tables unless you add `--force`. We did this during testing: every table matched row for row.
- A real recovery: stop the API (Render, Suspend), restore into a new empty database, point `DB_NAME` at it, run `npm run check:env`, start the API, then place one test order.

## 6. When something goes wrong

**The site shows errors.** Open `/api/ready`. If it says `db: down`, check TiDB Cloud status, then the `DB_*` settings, then SSL. If the API itself is down, read the last Render log lines and the deploy history; roll back to the previous deploy in Render.

**A customer paid but the order is not paid.** Find the reference in the Paystack dashboard. Open the transaction and re-send the webhook event if the dashboard offers it. If it still does not settle, the customer's return page calls verification too: ask them to open their order. A payment for the wrong amount or currency is deliberately held and emailed to the admin: refund it in Paystack or fix the order by hand.

**Webhooks failing.** Check the URL (section 2), that `PAYSTACK_SECRET_KEY` matches the key of the account that sends them, and that the server clock is right.

**Emails not arriving.** Resend dashboard: sending domain verified? Is `MAIL_FROM` on it? Spam folder? A new code can be requested from the verify page.

**A password or key may have leaked.**
1. Paystack: roll the secret key, update Render.
2. `JWT_SECRET`: set a new one. Everyone is logged out.
3. Database password: change it in TiDB and Render.
4. For one user: Admin, Users, suspend. The suspension takes effect on their very next request.
5. Review Admin, Activity for changes you do not recognise.

**Someone is abusing the site.** Rate limits already slow guessing (logins lock after 5 wrong tries for 15 minutes). For a single bad account, suspend it. For a flood, ask Render or Cloudflare to block the address.

**Write down afterwards:** what happened, when, how you found out, what fixed it, and what would have caught it sooner. Add a test for it.

## 7. Known items to watch

- `npm audit` currently reports advisories in `zod` (needs a major upgrade; our request bodies are capped at 100 KB, which limits the risk), `react-router` and `vite/esbuild` (development server only). Plan an upgrade window; the CI audit job reports them weekly.
