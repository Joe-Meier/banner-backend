const express = require('express');
const cors = require('cors');

// The banner is a grid of blocks. Buyers pick a rectangle of blocks; the server, not the browser, sets the price.
function readConfig(env) {
  const siteUrl = env.SITE_URL || 'https://joe-meier.github.io/Joecool/';
  return {
    siteUrl,
    allowedOrigins: (env.ALLOWED_ORIGINS || new URL(siteUrl).origin).split(',').map((s) => s.trim()).filter(Boolean),
    pricePerBlock: Number(env.PRICE_PER_BLOCK), // dollars
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    cols: Number(env.BANNER_COLS || 32),
    rows: Number(env.BANNER_ROWS || 8),
    termMonths: Number(env.TERM_MONTHS || 6),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    notifyEmail: env.NOTIFY_EMAIL || env.EMAIL_USER || ''
  };
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const isInt = (v) => Number.isInteger(v);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function parseImage(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m || !IMAGE_TYPES[m[1]]) return null;
  const content = Buffer.from(m[2], 'base64');
  if (!content.length || content.length > MAX_IMAGE_BYTES) return null;
  return { contentType: m[1], ext: IMAGE_TYPES[m[1]], content };
}

// Checks the buyer's details and spot. Returns { error } or the cleaned order.
function validateOrder(body, config) {
  const { customer = {}, selection = {} } = body || {};
  const name = clean(customer.name, 100);
  const email = clean(customer.email, 200);
  const company = clean(customer.company, 100);
  const url = clean(customer.url, 300);
  if (!name) return { error: 'Please add your name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please add a valid email.' };
  if (url && !/^https?:\/\/\S+$/i.test(url)) return { error: 'Your link should start with http:// or https://.' };
  const { x, y, width, height } = selection;
  if (![x, y, width, height].every(isInt) || x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > config.cols || y + height > config.rows) {
    return { error: 'That spot is off the banner.' };
  }
  const image = parseImage(body.image);
  if (!image) return { error: 'Please add your ad as a PNG, JPG, WebP or GIF under 4 MB.' };
  const blocks = width * height;
  return { customer: { name, email, company, url }, spot: { x, y, width, height, blocks }, image };
}

const spotLabel = (s) => `${s.width} × ${s.height} block${s.blocks === 1 ? '' : 's'}, starting ${s.x + 1} across, ${s.y + 1} down`;

function createApp({ stripe, mailer, config, log = console }) {
  const app = express();
  // Ad images wait here between checkout and payment, so they can go out with the "paid" email.
  const pending = new Map();

  // Stripe's webhook needs the raw body to check its signature, so it comes before express.json().
  app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!config.webhookSecret) return res.status(503).send('Webhook secret not set');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.webhookSecret);
    } catch (err) {
      log.warn('Webhook signature check failed:', err.message);
      return res.status(400).send('Bad signature');
    }
    if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
      const session = event.data.object, md = session.metadata || {};
      const order = pending.get(session.id);
      pending.delete(session.id);
      const spot = { x: +md.spot_x, y: +md.spot_y, width: +md.spot_width, height: +md.spot_height, blocks: +md.spot_blocks };
      const amount = `${(session.amount_total / 100).toFixed(2)} ${String(session.currency).toUpperCase()}`;
      const lines = [
        `Someone bought a spot on your banner: ${spotLabel(spot)}.`,
        `Paid: ${amount}`,
        `Buyer: ${md.customer_name} <${session.customer_details?.email || session.customer_email || ''}>`,
        md.customer_company ? `Company: ${md.customer_company}` : null,
        md.customer_url ? `Link: ${md.customer_url}` : null,
        `Stripe checkout session: ${session.id}`,
        '',
        order ? 'Their ad is attached.' : "The server restarted before payment came through, so the ad image is missing. Ask them to email it to you.",
        '',
        'To put it up, add this to BANNER.sold in index.html (and save the image in a banner/ folder next to it):',
        `{ x: ${spot.x}, y: ${spot.y}, w: ${spot.width}, h: ${spot.height}, image: "banner/${session.id.slice(-8)}.${order ? order.image.ext : 'png'}", url: "${md.customer_url || ''}", name: "${(md.customer_company || md.customer_name || '').replace(/"/g, "'")}" }`
      ].filter((l) => l !== null);
      try {
        await notify(`Banner spot sold: ${spot.width} × ${spot.height} for ${amount}`, lines.join('\n'),
          order ? [{ filename: `${session.id.slice(-8)}.${order.image.ext}`, content: order.image.content, contentType: order.image.contentType }] : []);
      } catch (err) {
        log.error('Could not send the sale email:', err.message);
      }
    }
    res.json({ received: true });
  });

  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: '6mb' }));

  async function notify(subject, text, attachments) {
    if (!mailer || !config.notifyEmail) { log.info(`[email skipped] ${subject}\n${text}`); return; }
    await mailer.sendMail({ from: config.notifyEmail, to: config.notifyEmail, subject, text, attachments });
  }

  app.post('/create-checkout-session', async (req, res) => {
    if (!(config.pricePerBlock > 0)) return res.status(503).json({ error: 'Sales are closed right now.' });
    const order = validateOrder(req.body, config);
    if (order.error) return res.status(400).json({ error: order.error });
    const { customer, spot } = order;
    try {
      const sep = config.siteUrl.includes('?') ? '&' : '?';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: spot.blocks,
          price_data: {
            currency: config.currency,
            unit_amount: Math.round(config.pricePerBlock * 100),
            product_data: {
              name: `Banner ad space, ${new URL(config.siteUrl).host}`,
              description: `${spotLabel(spot)}, for ${config.termMonths} months`
            }
          }
        }],
        customer_email: customer.email,
        metadata: {
          customer_name: customer.name,
          customer_company: customer.company,
          customer_url: customer.url,
          spot_x: String(spot.x), spot_y: String(spot.y),
          spot_width: String(spot.width), spot_height: String(spot.height),
          spot_blocks: String(spot.blocks)
        },
        success_url: `${config.siteUrl}${sep}banner=paid#banner`,
        cancel_url: `${config.siteUrl}${sep}banner=cancelled#banner`
      });
      pending.set(session.id, { image: order.image, at: Date.now() });
      // Forget images for checkouts nobody finished after a day.
      for (const [id, p] of pending) if (Date.now() - p.at > 864e5) pending.delete(id);
      res.json({ url: session.url, total: spot.blocks * config.pricePerBlock, currency: config.currency });
    } catch (err) {
      log.error('Error creating checkout session:', err.message);
      res.status(500).json({ error: 'Checkout is having a moment. Please try again.' });
    }
  });

  // The site asks this for the live price, so the number on the page always matches what Stripe charges.
  app.get('/config', (req, res) => {
    res.json({ pricePerBlock: config.pricePerBlock > 0 ? config.pricePerBlock : null, currency: config.currency, cols: config.cols, rows: config.rows, termMonths: config.termMonths });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Banner backend is running!' });
  });

  return app;
}

module.exports = { createApp, readConfig, validateOrder };
