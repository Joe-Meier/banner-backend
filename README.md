# banner-backend

Takes payments for ad space on the banner at the top of joe-meier.github.io/Joecool, and gives you a private page to approve each ad before it goes up.

How it works:

1. A visitor uploads their ad on the site, drags and scales it across the banner's squares, and sees the price as they go.
2. They pay on Stripe. The server sets the price from the number of squares (the browser's number is never trusted).
3. You get an email, and the order shows up on your admin page at `https://<your-server>/admin`.
4. You hit **Approve and put it up**, and the server commits the ad into the site's repo (`banner/ads.json` plus the image). GitHub Pages redeploys and it's on the banner a minute or two later. Or hit **Refund it** and Stripe refunds them in full.

Orders and their images are kept in a private GitHub repo, because the server's disk is wiped every time it redeploys.

## Endpoints

- `POST /create-checkout-session`: takes `{ customer: { name, email, company?, url? }, selection: { x, y, width, height }, image }`, where the selection is in squares from the top left and `image` is a PNG, JPG, WebP or GIF data URL under 4 MB. Saves the order and returns `{ url }`, the Stripe Checkout page to send the buyer to. Spots that are taken, or paid for and waiting on you, are turned away.
- `POST /webhook`: Stripe calls this when a checkout is paid (or expires).
- `GET /config`: the live price per square, so the site shows the same number Stripe charges.
- `GET /admin`: your approval page, behind a password.
- `GET /health`

## Settings

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | From Stripe › Developers › API keys. Use the `sk_test_...` key until you've tried a test purchase. |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_...` signing secret from the webhook you add below. |
| `PRICE_PER_BLOCK` | Dollars per square, like `1.50`. Checkout stays closed until this is set. |
| `ADMIN_PASSWORD` | The password for `/admin`. Your browser asks for it; any username works. |
| `GITHUB_TOKEN` | A fine-grained token that can read and write the contents of the orders repo and the site repo (see below). |
| `ORDERS_REPO` | The private repo orders are kept in, like `Joe-Meier/banner-orders`. |
| `SITE_REPO` | The site's repo. Defaults to `Joe-Meier/Joecool`. |
| `SITE_URL` | Where buyers come back to. Defaults to `https://joe-meier.github.io/Joecool/`. |
| `EMAIL_USER`, `EMAIL_PASS` | A Gmail address and an [app password](https://myaccount.google.com/apppasswords) for it, used to email you each sale. |
| `NOTIFY_EMAIL` | Where sale emails go. Defaults to `EMAIL_USER`. |
| `BANNER_COLS`, `BANNER_ROWS`, `TERM_MONTHS`, `CURRENCY` | Optional. Default to 64, 20, 6 and `usd`, matching the site. |

## Setting it up

1. On GitHub, make a new **private** repo called `banner-orders` (empty is fine).
2. On GitHub, go to Settings › Developer settings › Fine-grained tokens and make a token with access to just `banner-orders` and `Joecool`, with **Contents: Read and write**. That's `GITHUB_TOKEN`.
3. This runs on Railway (the banner-backend service), which redeploys whenever `main` changes. Starting fresh: Railway › New › Deploy from GitHub repo, pick this repo, and it runs `npm start` on its own. Render works too (New › Web Service, start command `npm start`).
4. Add the settings above under the service's Variables.
5. In Stripe › Developers › Webhooks, add an endpoint at `https://<your-service>.up.railway.app/webhook` for the `checkout.session.completed` and `checkout.session.expired` events, then copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
6. Put `https://<your-service>.up.railway.app` into `BANNER.checkoutApi` in the site's index.html.

Approved ads don't depend on the server staying up: they're plain files in the site's repo.

## Running it locally

```
npm install
cp .env.example .env   # then fill it in
npm start
npm test
```

Without `GITHUB_TOKEN` and `ORDERS_REPO`, orders are kept in memory, which is fine for trying it out.
