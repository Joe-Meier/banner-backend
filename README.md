# banner-backend

Takes payments for ad space on the banner at the top of joe-meier.github.io/Joecool, and gives you a private page to approve each ad before it goes up.

How it works:

1. A visitor uploads their ad on the site, drags and scales it across the banner's squares, and sees the price as they go.
2. They pay on Stripe. The server sets the price from the number of squares (the browser's number is never trusted).
3. The server asks Stripe whether they paid (when they come back to the site, and every two minutes in case they don't), so there's no webhook to set up. You get an email, and the order shows up on your admin page at `https://<your-server>/admin`.
4. You hit **Approve and put it up**, and the server commits the ad into the site's repo (`banner/ads.json` plus the image). GitHub Pages redeploys and it's on the banner a minute or two later. Or hit **Refund it** and Stripe refunds them in full.

Orders and their images are kept in a private GitHub repo, because the server's disk is wiped every time it redeploys.

## Endpoints

- `POST /create-checkout-session`: takes `{ customer: { name, email, company?, url? }, selection: { x, y, width, height }, image }`, where the selection is in squares from the top left and `image` is a PNG, JPG, WebP or GIF data URL under 4 MB. Saves the order and returns `{ url }`, the Stripe Checkout page to send the buyer to. Spots that are taken, or paid for and waiting on you, are turned away.
- `POST /confirm`: takes `{ sessionId }`. The site calls it when a buyer comes back from Stripe; the server checks that checkout with Stripe.
- `POST /webhook`: optional. If you'd rather Stripe told the server, add a webhook here for `checkout.session.completed` and `checkout.session.expired` and set `STRIPE_WEBHOOK_SECRET`.
- `GET /config`: the live price per square, so the site shows the same number Stripe charges.
- `GET /admin`: your approval page, behind a password.
- `GET /health`

## Settings

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | From Stripe › Developers › API keys. Use the `sk_test_...` key until you've tried a test purchase. |
| `PRICE_PER_BLOCK` | Dollars per square. Defaults to `1.50`; `0` closes checkout. |
| `ADMIN_PASSWORD` | The password for `/admin`. Your browser asks for it; any username works. |
| `GITHUB_TOKEN` | A fine-grained token that can read and write the contents of the orders repo and the site repo (see below). |
| `ORDERS_REPO` | The private repo orders are kept in. Defaults to `Joe-Meier/banner-orders`. |
| `SITE_REPO` | The site's repo. Defaults to `Joe-Meier/Joecool`. |
| `SITE_URL` | Where buyers come back to. Defaults to `https://joe-meier.github.io/Joecool/`. |
| `ALLOWED_ORIGINS` | Optional. Which sites may use checkout, comma-separated. Defaults to joemeier.cool (with and without www), GitHub's address and `SITE_URL`. |
| `RESEND_API_KEY` | For sale emails on Render, whose free plan blocks Gmail's SMTP. Sign up free at resend.com with the address in `NOTIFY_EMAIL`/`EMAIL_USER` and make an API key. Emails come from `onboarding@resend.dev` unless you set `EMAIL_FROM` on a domain you've verified there. |
| `EMAIL_USER`, `EMAIL_PASS` | A Gmail address and an [app password](https://myaccount.google.com/apppasswords) for it, used to email you each sale when `RESEND_API_KEY` isn't set, on hosts that allow SMTP. |
| `NOTIFY_EMAIL` | Where sale emails go. Defaults to `EMAIL_USER`. |
| `BANNER_COLS`, `BANNER_ROWS`, `TERM_MONTHS`, `CURRENCY` | Optional. Default to 10, 250, 3 and `usd`, matching the site's strip down the right side. |

## Setting it up

1. On GitHub, make a new **private** repo called `banner-orders` (empty is fine): https://github.com/new?name=banner-orders&visibility=private
2. On GitHub, go to Settings › Developer settings › Fine-grained tokens and make a token with access to just `banner-orders` and `Joecool`, with **Contents: Read and write**. That's `GITHUB_TOKEN`.
3. Click https://render.com/deploy?repo=https://github.com/Joe-Meier/banner-backend/tree/site-checkout, sign in with GitHub, and fill in the five values it asks for: `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, `ADMIN_PASSWORD`, `EMAIL_USER` and `EMAIL_PASS`. It sets up a free web service from `render.yaml` and redeploys whenever the `site-checkout` branch changes. (Railway works too: add the same values under the service's Variables.)
4. Put the service's address (`https://<name>.onrender.com`) into `BANNER.checkoutApi` in the site's index.html.

Render's free plan sleeps after 15 minutes with no visitors and takes about a minute to wake up. The site wakes it as soon as someone opens the page (it asks the server for the price), and nothing is lost while it sleeps: orders live in GitHub, payments in Stripe, and the server catches up with Stripe when it wakes.

On Railway or Render, checkout stays closed until `STRIPE_SECRET_KEY` and `GITHUB_TOKEN` are set, so nobody can pay for an ad that would have nowhere to go.

Approved ads don't depend on the server staying up: they're plain files in the site's repo.

## Running it locally

```
npm install
cp .env.example .env   # then fill it in
npm start
npm test
```

Without `GITHUB_TOKEN`, orders are kept in memory, which is fine for trying it out.
