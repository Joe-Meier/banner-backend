// Merch: products jo makes in Printful, sold on the site with Stripe's embedded checkout, so buyers never leave
// joemeier.cool. When a checkout is paid, the server sends the order to Printful, which prints and ships it.
//
// Nothing is kept on this server. Printful has the products and prices, Stripe has the payments, and the
// Printful order's external_id comes from the Stripe checkout, so the same checkout can never be ordered twice.
const crypto = require('crypto');
const express = require('express');

// Embedded checkout needs a newer Stripe API version than the banner's checkout uses, so merch calls ask for it.
const STRIPE_API = { apiVersion: '2023-10-16' };
const PRODUCTS_TTL = 10 * 60 * 1000;

function readMerchConfig(env) {
  const shipping = Number(env.MERCH_SHIPPING ?? 6);
  return {
    token: env.PRINTFUL_API_TOKEN || '',
    storeId: env.PRINTFUL_STORE_ID || '', // only for a token that covers every store on the account
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    shipping: Number.isFinite(shipping) && shipping >= 0 ? shipping : 6, // one flat rate, in dollars
    countries: (env.MERCH_COUNTRIES || 'US').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    // Test payments make draft orders in Printful (nothing gets printed or charged). Live payments are confirmed
    // straight away, unless PRINTFUL_CONFIRM=0, which leaves every order as a draft for jo to confirm in Printful.
    confirm: env.PRINTFUL_CONFIRM === '0' ? false : String(env.STRIPE_SECRET_KEY || '').startsWith('sk_live_'),
    maxQuantity: 5
  };
}

function printfulClient({ token, storeId, fetch: f = globalThis.fetch }) {
  async function call(method, path, body) {
    const res = await f('https://api.printful.com' + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`, 'user-agent': 'banner-backend',
        ...(storeId ? { 'x-pf-store-id': String(storeId) } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Printful said ${res.status}: ${(json.error && json.error.message) || json.result || 'no reason given'}`);
      err.status = res.status;
      err.reason = String((json.error && json.error.message) || json.result || '');
      throw err;
    }
    return json.result;
  }
  return {
    listProducts: () => call('GET', '/store/products?limit=100'),
    getProduct: (id) => call('GET', `/store/products/${encodeURIComponent(id)}`),
    createOrder: (order, confirm) => call('POST', `/orders${confirm ? '?confirm=true' : ''}`, order)
  };
}

const cents = (dollars) => Math.round(Number(dollars) * 100);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Printful keeps an order's external_id to 32 characters, so it's a hash of the Stripe checkout's id.
const externalId = (sessionId) => crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);

// What the site shows: each product with the variants people can buy (size, color) and their prices.
function shapeProduct({ sync_product: p, sync_variants: vs = [] }) {
  const variants = vs
    .filter((v) => !v.is_ignored && v.synced !== false && v.availability_status !== 'discontinued' && Number(v.retail_price) > 0)
    .map((v) => {
      const preview = (v.files || []).find((f) => f.type === 'preview');
      return {
        id: v.id,
        catalogId: v.variant_id,
        name: [v.color, v.size].filter(Boolean).join(' / ') || v.name,
        price: Number(v.retail_price),
        currency: String(v.currency || 'USD').toLowerCase(),
        image: (preview && preview.preview_url) || (v.product && v.product.image) || p.thumbnail_url || '',
        soldOut: ['out_of_stock', 'temporary_out_of_stock'].includes(v.availability_status)
      };
    });
  return { id: p.id, name: p.name, image: p.thumbnail_url || (variants[0] && variants[0].image) || '', variants };
}

function merchRoutes({ stripe, printful, stripeReady, merchConfig: mc, log = console }) {
  const router = express.Router();
  let notify = async () => {};
  const open = () => Boolean(printful && mc.publishableKey && stripeReady);

  // Printful is asked for the products at most every ten minutes.
  let cache = null, loading = null;
  async function products(fresh = false) {
    if (!fresh && cache && Date.now() - cache.at < PRODUCTS_TTL) return cache.list;
    if (!loading) {
      loading = (async () => {
        const list = (await printful.listProducts()).filter((p) => !p.is_ignored);
        const full = await Promise.all(list.map((p) => printful.getProduct(p.id)));
        const shaped = full.map(shapeProduct).filter((p) => p.variants.length);
        cache = { at: Date.now(), list: shaped };
        return shaped;
      })().finally(() => { loading = null; });
    }
    return loading;
  }
  async function findVariant(id) {
    const look = (list) => { for (const p of list) { const v = p.variants.find((x) => x.id === id); if (v) return { product: p, variant: v }; } return null; };
    return look(await products()) || look(await products(true));
  }

  router.get('/merch', async (req, res) => {
    if (!open()) return res.json({ open: false, products: [] });
    try {
      res.set('cache-control', 'public, max-age=60').json({
        open: true, publishableKey: mc.publishableKey, shipping: mc.shipping, countries: mc.countries, products: await products()
      });
    } catch (err) {
      log.error('Could not get the merch from Printful:', err.message);
      res.status(502).json({ error: "The shop didn't load. Try again in a bit." });
    }
  });

  router.post('/merch/checkout', async (req, res) => {
    if (!open()) return res.status(503).json({ error: 'The shop is closed right now.' });
    const body = req.body || {};
    const variantId = Number(body.variant), quantity = Number(body.quantity || 1);
    if (!Number.isInteger(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > mc.maxQuantity) {
      return res.status(400).json({ error: 'Pick a size first.' });
    }
    try {
      const found = await findVariant(variantId);
      if (!found) return res.status(404).json({ error: "That one isn't for sale anymore." });
      const { product, variant } = found;
      if (variant.soldOut) return res.status(409).json({ error: "That size is sold out. Pick another one." });
      const session = await stripe.checkout.sessions.create({
        ui_mode: 'embedded',
        redirect_on_completion: 'never',
        mode: 'payment',
        line_items: [{
          quantity,
          price_data: {
            currency: variant.currency,
            unit_amount: cents(variant.price),
            product_data: { name: product.name, description: variant.name, ...(variant.image ? { images: [variant.image] } : {}) }
          }
        }],
        shipping_address_collection: { allowed_countries: mc.countries },
        shipping_options: [{ shipping_rate_data: {
          type: 'fixed_amount', display_name: 'Printed and shipped',
          fixed_amount: { amount: cents(mc.shipping), currency: variant.currency },
          delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 12 } }
        } }],
        phone_number_collection: { enabled: true },
        metadata: { kind: 'merch', variant: String(variant.id), quantity: String(quantity), item: `${product.name} (${variant.name})`.slice(0, 450) }
      }, STRIPE_API);
      res.json({ clientSecret: session.client_secret, sessionId: session.id });
    } catch (err) {
      log.error('Error creating merch checkout:', err.message);
      res.status(500).json({ error: 'Checkout is having a moment. Please try again.' });
    }
  });

  // A paid merch checkout becomes a Printful order. The payment's metadata remembers it, so it only happens once.
  const sending = new Set();
  async function fulfil(session) {
    if (!session || !session.metadata || session.metadata.kind !== 'merch' || session.payment_status !== 'paid') return null;
    const pi = typeof session.payment_intent === 'string' ? await stripe.paymentIntents.retrieve(session.payment_intent) : session.payment_intent;
    if (pi && pi.metadata && pi.metadata.printful_order) return pi.metadata.printful_order;
    if (sending.has(session.id)) return null;
    sending.add(session.id);
    const item = session.metadata.item;
    // Stripe moved this in newer API versions (a webhook arrives in the account's version), so both places are checked.
    const ship = session.shipping_details || (session.collected_information && session.collected_information.shipping_details) || {};
    const a = ship.address || {};
    const buyer = session.customer_details || {};
    const amount = `${(session.amount_total / 100).toFixed(2)} ${String(session.currency || 'usd').toUpperCase()}`;
    try {
      let printfulId;
      try {
        const made = await printful.createOrder({
          external_id: externalId(session.id),
          shipping: 'STANDARD',
          recipient: {
            name: clean(ship.name || buyer.name, 100), email: clean(buyer.email, 200), phone: clean(buyer.phone, 40),
            address1: clean(a.line1, 200), address2: clean(a.line2, 200), city: clean(a.city, 100),
            state_code: clean(a.state, 10), country_code: clean(a.country, 2), zip: clean(a.postal_code, 20)
          },
          items: [{ sync_variant_id: Number(session.metadata.variant), quantity: Number(session.metadata.quantity) || 1 }],
          retail_costs: { shipping: mc.shipping.toFixed(2) }
        }, mc.confirm);
        printfulId = String(made.id);
      } catch (err) {
        // Already sent (say the server restarted halfway): Printful turns away the same external_id twice.
        if (!/external.?id/i.test(err.reason || '')) throw err;
        printfulId = 'sent';
      }
      if (pi) await stripe.paymentIntents.update(pi.id, { metadata: { printful_order: printfulId } }).catch((err) => log.warn('Could not mark the payment as ordered:', err.message));
      if (printfulId !== 'sent') {
        await notify(`Merch sold: ${item} for ${amount}`, [
          `${buyer.name || 'Someone'} <${buyer.email || 'no email'}> bought ${session.metadata.quantity} × ${item}.`,
          `Paid: ${amount}, shipping included.`,
          `Ship to: ${[ship.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')}`,
          '',
          mc.confirm
            ? `It's gone to Printful as order ${printfulId} and is being printed.`
            : `It's in Printful as draft order ${printfulId}. Nothing gets printed until you confirm it there: https://www.printful.com/dashboard/default/orders`
        ].join('\n')).catch((err) => log.error('Could not send the merch email:', err.message));
      }
      return printfulId;
    } catch (err) {
      log.error(`Could not send checkout ${session.id} to Printful:`, err.message);
      await notify(`Merch sold, but it didn't reach Printful: ${item}`, [
        `${buyer.name || 'Someone'} <${buyer.email || 'no email'}> paid ${amount} for ${session.metadata.quantity} × ${item}, but Printful turned the order away:`,
        err.message,
        '',
        `Ship to: ${[ship.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')}`,
        `The server tries again every couple of minutes for two days. Or make the order in Printful by hand, or refund them in Stripe (checkout ${session.id}).`
      ].join('\n')).catch(() => {});
      return null;
    } finally {
      sending.delete(session.id);
    }
  }

  // The site calls this when the buyer finishes paying.
  router.post('/merch/confirm', async (req, res) => {
    const sessionId = req.body && req.body.sessionId;
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return res.status(400).json({ error: 'No checkout.' });
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {}, STRIPE_API);
      if (!session.metadata || session.metadata.kind !== 'merch') return res.status(404).json({ error: 'No such checkout.' });
      await fulfil(session);
      res.json({ paid: session.payment_status === 'paid' });
    } catch (err) {
      log.warn('Merch confirm failed:', err.message);
      res.status(404).json({ error: 'No such checkout.' });
    }
  });

  // In case the buyer closed the page right after paying: every couple of minutes, paid merch checkouts from the
  // last two days that never reached Printful are sent.
  async function sync() {
    if (!open()) return;
    const since = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000);
    const list = await stripe.checkout.sessions.list({ created: { gte: since }, status: 'complete', limit: 100, expand: ['data.payment_intent'] }, STRIPE_API);
    for (const s of list.data || []) {
      if (!s.metadata || s.metadata.kind !== 'merch' || s.payment_status !== 'paid') continue;
      if (s.payment_intent && s.payment_intent.metadata && s.payment_intent.metadata.printful_order) continue;
      try { await fulfil(s); } catch (err) { log.warn(`Merch sync for ${s.id} failed:`, err.message); }
    }
  }

  // The app hands over its email function when it mounts the routes.
  const mount = (send) => { if (send) notify = send; return router; };
  return { router: mount, fulfil, sync, products };
}

module.exports = { merchRoutes, printfulClient, readMerchConfig, shapeProduct, externalId };
