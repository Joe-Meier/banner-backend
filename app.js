const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// The banner is a grid of squares. Buyers pick a rectangle of squares and upload their ad; the server, not the
// browser, sets the price. After they pay, jo approves the ad on /admin and it goes up on the banner.
function readConfig(env) {
  const siteUrl = env.SITE_URL || 'https://joe-meier.github.io/Joecool/';
  return {
    siteUrl,
    allowedOrigins: (env.ALLOWED_ORIGINS || new URL(siteUrl).origin).split(',').map((s) => s.trim()).filter(Boolean),
    pricePerBlock: Number(env.PRICE_PER_BLOCK ?? 1.5), // dollars per square; 0 closes checkout
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    cols: Number(env.BANNER_COLS || 64),
    rows: Number(env.BANNER_ROWS || 20),
    termMonths: Number(env.TERM_MONTHS || 6),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', // optional: the server also asks Stripe itself
    notifyEmail: env.NOTIFY_EMAIL || env.EMAIL_USER || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '')
  };
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const isInt = (v) => Number.isInteger(v);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const adSpot = (ad) => ({ x: ad.x, y: ad.y, width: ad.w, height: ad.h });

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
  return { customer: { name, email, company, url }, spot: { x, y, width, height, blocks: width * height }, image };
}

const spotLabel = (s) => `${s.width} × ${s.height} square${s.blocks === 1 ? '' : 's'}, starting ${s.x + 1} across, ${s.y + 1} down`;
const money = (n, currency) => `${Number(n).toFixed(2)} ${String(currency).toUpperCase()}`;
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

function createApp({ stripe, mailer, store, config, log = console }) {
  const app = express();

  async function notify(subject, text, attachments = []) {
    if (!mailer || !config.notifyEmail) { log.info(`[email skipped] ${subject}\n${text}`); return; }
    await mailer.sendMail({ from: config.notifyEmail, to: config.notifyEmail, subject, text, attachments });
  }

  // Spots that are spoken for: what's up on the banner, plus ads that are paid for and waiting on jo.
  async function takenSpots() {
    const [ads, orders] = await Promise.all([store.listAds(), store.listOrders()]);
    return [...ads.map(adSpot), ...orders.filter((o) => o.status === 'paid').map((o) => o.spot)];
  }

  // A checkout was paid: the order waits for jo, and jo gets an email with the ad.
  const marking = new Set();
  async function markPaid(id, session) {
    if (marking.has(id)) return;
    marking.add(id);
    try {
      const before = await store.getOrder(id);
      if (!before) {
        log.error(`Paid checkout ${session.id} has no order ${id}`);
        await notify('Banner spot paid, but the order is missing', `Stripe checkout session ${session.id} was paid, but order ${id} isn't in the orders repo. Check Stripe for the buyer.`);
        return;
      }
      if (before.status !== 'unpaid' && before.status !== 'expired') return;
      const order = await store.updateOrder(id, {
        status: 'paid', paidAt: new Date().toISOString(), paymentIntent: session.payment_intent,
        paid: session.amount_total / 100, sessionId: session.id
      });
      const image = await store.getImage(order).catch(() => null);
      const amount = money(order.paid, session.currency || config.currency);
      await notify(`Banner spot sold: ${order.spot.width} × ${order.spot.height} for ${amount}. Approve it?`, [
        `Someone bought a spot on your banner: ${spotLabel(order.spot)}.`,
        `Paid: ${amount}`,
        `Buyer: ${order.customer.name} <${order.customer.email}>`,
        order.customer.company ? `Company: ${order.customer.company}` : null,
        order.customer.url ? `Link: ${order.customer.url}` : null,
        '',
        `Their ad is attached. Approve it (it goes straight up on the banner) or refund it here: ${config.publicUrl ? config.publicUrl + '/admin' : '/admin on your server'}`
      ].filter((l) => l !== null).join('\n'), image ? [{ filename: `ad-${order.id}.${image.ext}`, content: image.content, contentType: image.contentType }] : []).catch((err) => log.error('Could not send the sale email:', err.message));
    } finally {
      marking.delete(id);
    }
  }
  async function settle(session) {
    const id = session.metadata && session.metadata.order_id;
    if (!id) return;
    if (session.payment_status === 'paid') return markPaid(id, session);
    if (session.status === 'expired') {
      const order = await store.getOrder(id);
      if (order && order.status === 'unpaid') await store.updateOrder(id, { status: 'expired' });
    }
  }

  // No webhook needed: the server asks Stripe about its open checkouts itself. It does this every couple of minutes,
  // when someone comes back from paying, before a new checkout, and when jo opens the admin page.
  let syncing = null;
  function syncPayments() {
    if (syncing) return syncing;
    syncing = (async () => {
      const since = Date.now() - 48 * 3600 * 1000;
      const open = (await store.listOrders()).filter((o) => o.status === 'unpaid' && o.sessionId && Date.parse(o.createdAt) > since);
      for (const o of open) {
        try { await settle(await stripe.checkout.sessions.retrieve(o.sessionId)); } catch (err) { log.warn(`Couldn't check checkout ${o.sessionId}:`, err.message); }
      }
    })().catch((err) => log.error('Payment check failed:', err.message)).finally(() => { syncing = null; });
    return syncing;
  }

  // Stripe's webhook (optional) needs the raw body to check its signature, so it comes before express.json().
  app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!config.webhookSecret) return res.status(503).send('Webhook secret not set');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.webhookSecret);
    } catch (err) {
      log.warn('Webhook signature check failed:', err.message);
      return res.status(400).send('Bad signature');
    }
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') await settle(event.data.object);
    } catch (err) {
      log.error('Webhook handling failed:', err.message);
      return res.status(500).send('Try again'); // Stripe retries
    }
    res.json({ received: true });
  });

  /* ---------- What the site talks to ---------- */
  const site = express.Router();
  site.use(cors({ origin: config.allowedOrigins }));
  site.use(express.json({ limit: '6mb' }));

  site.post('/create-checkout-session', async (req, res) => {
    if (!(config.pricePerBlock > 0)) return res.status(503).json({ error: 'Sales are closed right now.' });
    const valid = validateOrder(req.body, config);
    if (valid.error) return res.status(400).json({ error: valid.error });
    const { customer, spot, image } = valid;
    try {
      await syncPayments();
      if ((await takenSpots()).some((s) => overlaps(s, spot))) {
        return res.status(409).json({ error: 'Someone already has part of that spot. Pick another one.' });
      }
      const order = {
        id: crypto.randomBytes(5).toString('hex'), status: 'unpaid', createdAt: new Date().toISOString(),
        customer, spot, total: spot.blocks * config.pricePerBlock, currency: config.currency,
        termMonths: config.termMonths, image: { ext: image.ext, contentType: image.contentType }
      };
      // The ad is saved before they pay, so it's there for jo whenever the payment comes through.
      await store.putImage(order, image);
      await store.saveOrder(order);
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
        metadata: { order_id: order.id, spot: `${spot.x},${spot.y},${spot.width}x${spot.height}` },
        success_url: `${config.siteUrl}${sep}banner=paid&session_id={CHECKOUT_SESSION_ID}#banner`,
        cancel_url: `${config.siteUrl}${sep}banner=cancelled#banner`
      });
      await store.updateOrder(order.id, { sessionId: session.id }).catch(() => {});
      res.json({ url: session.url, total: order.total, currency: config.currency });
    } catch (err) {
      log.error('Error creating checkout session:', err.message);
      res.status(500).json({ error: 'Checkout is having a moment. Please try again.' });
    }
  });

  // The site calls this when a buyer comes back from paying, so jo hears about it straight away.
  site.post('/confirm', async (req, res) => {
    const sessionId = req.body && req.body.sessionId;
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return res.status(400).json({ error: 'No checkout.' });
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      await settle(session);
      res.json({ paid: session.payment_status === 'paid' });
    } catch (err) {
      log.warn('Confirm failed:', err.message);
      res.status(404).json({ error: 'No such checkout.' });
    }
  });

  // The site asks this for the live price, so the number on the page always matches what Stripe charges.
  site.get('/config', (req, res) => {
    res.json({ pricePerBlock: config.pricePerBlock > 0 ? config.pricePerBlock : null, currency: config.currency, cols: config.cols, rows: config.rows, termMonths: config.termMonths });
  });

  site.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Banner backend is running!' });
  });
  app.use(site);

  /* ---------- jo's admin page: approve, refund, take down ---------- */
  const safeEqual = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  function adminOnly(req, res, next) {
    if (!config.adminPassword) return res.status(503).send('Set ADMIN_PASSWORD on the server to use this page.');
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (pass && safeEqual(pass, config.adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Banner admin", charset="UTF-8"').status(401).send('This page is just for jo.');
  }
  // Buttons on the page send this header. Other sites can't, so they can't press the buttons for you.
  function fromAdminPage(req, res, next) {
    if (req.get('x-banner-admin') !== '1') return res.status(403).json({ error: 'Use the admin page.' });
    next();
  }

  const admin = express.Router();
  admin.use(adminOnly);
  admin.get('/', (req, res) => { res.set('Cache-Control', 'no-store').type('html').send(ADMIN_HTML); });
  admin.get('/api/orders', async (req, res) => {
    try {
      await syncPayments();
      const [orders, ads] = await Promise.all([store.listOrders(), store.listAds()]);
      orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.set('Cache-Control', 'no-store').json({ orders, ads, banner: { cols: config.cols, rows: config.rows, termMonths: config.termMonths, currency: config.currency, pricePerBlock: config.pricePerBlock || null } });
    } catch (err) {
      log.error('Could not load orders:', err.message);
      res.status(500).json({ error: `Couldn't load the orders: ${err.message}` });
    }
  });
  admin.get('/api/orders/:id/image', async (req, res) => {
    try {
      const order = await store.getOrder(req.params.id);
      const image = order && await store.getImage(order);
      if (!image) return res.status(404).send('No image');
      res.set('Cache-Control', 'private, max-age=86400').type(image.contentType).send(image.content);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  async function act(req, res, wanted, run) {
    try {
      const order = await store.getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (order.status !== wanted) return res.status(409).json({ error: `That order is ${order.status}, so it can't do that.` });
      res.json({ order: await run(order) });
    } catch (err) {
      log.error(`Admin action on ${req.params.id} failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  }
  admin.post('/api/orders/:id/approve', fromAdminPage, (req, res) => act(req, res, 'paid', async (order) => {
    const ads = await store.listAds();
    if (ads.some((ad) => overlaps(adSpot(ad), order.spot))) throw new Error('Another ad is already up in part of that spot.');
    const image = await store.getImage(order);
    if (!image) throw new Error("Couldn't find this order's image.");
    const now = new Date(), until = new Date(now);
    until.setMonth(until.getMonth() + (order.termMonths || config.termMonths));
    const ad = {
      id: order.id, x: order.spot.x, y: order.spot.y, w: order.spot.width, h: order.spot.height,
      image: `banner/${order.id}.${order.image.ext}`, url: order.customer.url || '', name: order.customer.company || order.customer.name,
      until: until.toISOString().slice(0, 10)
    };
    await store.publishAd(ad, image);
    return store.updateOrder(order.id, { status: 'live', approvedAt: now.toISOString(), until: ad.until });
  }));
  admin.post('/api/orders/:id/reject', fromAdminPage, (req, res) => act(req, res, 'paid', async (order) => {
    if (order.paymentIntent) await stripe.refunds.create({ payment_intent: order.paymentIntent });
    return store.updateOrder(order.id, { status: 'refunded', refundedAt: new Date().toISOString() });
  }));
  admin.post('/api/orders/:id/remove', fromAdminPage, (req, res) => act(req, res, 'live', async (order) => {
    await store.removeAd(order.id);
    return store.updateOrder(order.id, { status: 'removed', removedAt: new Date().toISOString() });
  }));
  app.use('/admin', admin);

  app.syncPayments = syncPayments;
  return app;
}

module.exports = { createApp, readConfig, validateOrder, overlaps };
