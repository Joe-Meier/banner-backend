# banner-backend

Takes payments for ad space on the banner at the top of joe-meier.github.io/Joecool. Visitors drag across the banner to pick a block of spots, upload their ad and pay on Stripe. The server sets the price from the number of blocks (the browser's number is never trusted), and emails you the spot, the buyer and their ad once the payment goes through.

## Endpoints

- `POST /create-checkout-session`: takes `{ customer: { name, email, company?, url? }, selection: { x, y, width, height }, image }`, where the selection is in blocks from the top left and `image` is a PNG, JPG, WebP or GIF data URL under 4 MB. Returns `{ url }`, the Stripe Checkout page to send the buyer to.
- `POST /webhook`: Stripe calls this when a checkout is paid.
- `GET /config`: the live price per block, so the site shows the same number Stripe charges.
- `GET /health`

## Settings

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | From Stripe › Developers › API keys. Use the `sk_test_...` key until you've tried a test purchase. |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_...` signing secret from the webhook you add below. |
| `PRICE_PER_BLOCK` | Dollars per block, like `25`. Checkout stays closed until this is set. |
| `SITE_URL` | Where buyers come back to. Defaults to `https://joe-meier.github.io/Joecool/`. |
| `EMAIL_USER`, `EMAIL_PASS` | A Gmail address and an [app password](https://myaccount.google.com/apppasswords) for it, used to email you each sale. |
| `NOTIFY_EMAIL` | Where sale emails go. Defaults to `EMAIL_USER`. |
| `BANNER_COLS`, `BANNER_ROWS`, `TERM_MONTHS`, `CURRENCY` | Optional. Default to 32, 8, 6 and `usd`, matching the site. |

## Putting it online (Render's free plan)

1. On render.com, choose New › Web Service and pick this repo.
2. Build command `npm install`, start command `npm start`.
3. Add the settings above under Environment.
4. In Stripe › Developers › Webhooks, add an endpoint at `https://<your-service>.onrender.com/webhook` for the `checkout.session.completed` event, then copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Put `https://<your-service>.onrender.com` into `BANNER.checkoutApi` in the site's index.html.

The free plan sleeps when nobody's using it, so the first checkout after a quiet spell takes up to a minute to start.

## Running it locally

```
npm install
cp .env.example .env   # then fill it in
npm start
npm test
```
