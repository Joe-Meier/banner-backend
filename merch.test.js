const test = require('node:test');
const assert = require('node:assert');
const { createApp, readConfig } = require('./app');
const { memoryStore } = require('./store');
const { merchRoutes, printfulClient, readMerchConfig, externalId } = require('./merch');

const quiet = { info() {}, warn() {}, error() {} };
const TEE = {
  sync_product: { id: 11, name: 'Ex Boyfriend Tee', thumbnail_url: 'https://files.cdn.printful.com/tee.png' },
  sync_variants: [
    { id: 101, variant_id: 4012, name: 'Ex Boyfriend Tee / Black / M', color: 'Black', size: 'M', retail_price: '30.00', currency: 'USD', synced: true, availability_status: 'active', files: [{ type: 'preview', preview_url: 'https://files.cdn.printful.com/m.png' }] },
    { id: 102, variant_id: 4013, name: 'Ex Boyfriend Tee / Black / L', color: 'Black', size: 'L', retail_price: '30.00', currency: 'USD', synced: true, availability_status: 'out_of_stock', files: [] },
    { id: 103, variant_id: 4014, name: 'Ex Boyfriend Tee / Black / XL', color: 'Black', size: 'XL', retail_price: '32.00', currency: 'USD', synced: true, is_ignored: true, files: [] }
  ]
};

function setup(env = {}) {
  const created = [], orders = [], sent = [], piUpdates = [], sessions = new Map(), pis = new Map();
  let n = 0, failNext = null;
  const stripe = {
    checkout: { sessions: {
      create: async (params, opts) => {
        created.push({ params, opts }); n++;
        const s = { id: `cs_test_m${n}`, client_secret: `cs_test_m${n}_secret`, status: 'open', payment_status: 'unpaid', metadata: params.metadata, currency: 'usd', created: Math.floor(Date.now() / 1000) };
        sessions.set(s.id, s);
        return s;
      },
      retrieve: async (id) => { if (!sessions.has(id)) throw new Error('No such checkout.session'); return { ...sessions.get(id) }; },
      list: async (params) => ({ data: [...sessions.values()].filter((s) => s.status === params.status).map((s) => ({ ...s, payment_intent: pis.get(s.payment_intent) || null })) })
    } },
    paymentIntents: {
      retrieve: async (id) => ({ ...pis.get(id), metadata: { ...pis.get(id).metadata } }),
      update: async (id, p) => { piUpdates.push(p); Object.assign(pis.get(id).metadata, p.metadata); return pis.get(id); }
    },
    refunds: { create: async () => ({}) },
    webhooks: { constructEvent: (b) => JSON.parse(b.toString()) }
  };
  const seen = new Set();
  const printful = {
    listProducts: async () => [{ id: 11, name: 'Ex Boyfriend Tee' }],
    getProduct: async () => TEE,
    createOrder: async (order, confirm) => {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      if (seen.has(order.external_id)) { const e = new Error('Printful said 400'); e.reason = 'Order with this External ID already exists'; throw e; }
      seen.add(order.external_id); orders.push({ order, confirm }); return { id: 9000 + orders.length };
    }
  };
  const merchConfig = readMerchConfig({ STRIPE_PUBLISHABLE_KEY: 'pk_test_1', STRIPE_SECRET_KEY: 'sk_test_1', ...env });
  const merch = merchRoutes({ stripe, printful, merchConfig, stripeReady: true, log: quiet });
  const config = readConfig({ EMAIL_USER: 'jo@example.com', ADMIN_PASSWORD: 'x' });
  const mailer = { sendMail: async (m) => { sent.push(m); } };
  const server = createApp({ stripe, mailer, store: memoryStore(), config, merch, log: quiet }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const pay = (id) => {
    pis.set(`pi_${id}`, { id: `pi_${id}`, metadata: {} });
    return Object.assign(sessions.get(id), {
      status: 'complete', payment_status: 'paid', amount_total: 3600, payment_intent: `pi_${id}`,
      customer_details: { name: 'Ada', email: 'ada@example.com', phone: '555' },
      shipping_details: { name: 'Ada L', address: { line1: '1 Main St', city: 'Brooklyn', state: 'NY', postal_code: '11201', country: 'US' } }
    });
  };
  return { created, orders, sent, piUpdates, server, base, pay, app: server, merch, fail: (e) => { failNext = e; } };
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://joemeier.cool' }, body: JSON.stringify(body) });

test('lists the products from Printful, without ignored variants', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  const res = await (await fetch(s.base + '/merch')).json();
  assert.equal(res.open, true);
  assert.equal(res.publishableKey, 'pk_test_1');
  assert.deepEqual(res.products[0].variants.map((v) => [v.id, v.name, v.price, v.soldOut]), [[101, 'Black / M', 30, false], [102, 'Black / L', 30, true]]);
  assert.equal(res.products[0].variants[0].image, 'https://files.cdn.printful.com/m.png');
});

test('closed without a publishable key', async (t) => {
  const s = setup({ STRIPE_PUBLISHABLE_KEY: '' }); t.after(() => s.server.close());
  assert.deepEqual(await (await fetch(s.base + '/merch')).json(), { open: false, products: [] });
  assert.equal((await post(s.base, '/merch/checkout', { variant: 101 })).status, 503);
});

test('makes an embedded checkout at the Printful price, not the browser\'s', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  const res = await post(s.base, '/merch/checkout', { variant: 101, quantity: 2, price: 1 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).clientSecret, 'cs_test_m1_secret');
  const { params, opts } = s.created[0];
  assert.equal(params.ui_mode, 'embedded');
  assert.equal(params.redirect_on_completion, 'never');
  assert.equal(params.line_items[0].price_data.unit_amount, 3000);
  assert.equal(params.line_items[0].quantity, 2);
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 600);
  assert.deepEqual(params.shipping_address_collection.allowed_countries, ['US']);
  assert.equal(opts.apiVersion, '2023-10-16');
});

test('turns away sold-out, ignored, unknown and silly orders', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  assert.equal((await post(s.base, '/merch/checkout', { variant: 102 })).status, 409);
  assert.equal((await post(s.base, '/merch/checkout', { variant: 103 })).status, 404);
  assert.equal((await post(s.base, '/merch/checkout', { variant: 999 })).status, 404);
  assert.equal((await post(s.base, '/merch/checkout', { variant: 101, quantity: 50 })).status, 400);
  assert.equal((await post(s.base, '/merch/checkout', { variant: 'x' })).status, 400);
});

test('a paid checkout becomes one Printful order (a draft in test mode) and emails jo', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  await post(s.base, '/merch/checkout', { variant: 101 });
  assert.deepEqual(await (await post(s.base, '/merch/confirm', { sessionId: 'cs_test_m1' })).json(), { paid: false });
  assert.equal(s.orders.length, 0);
  s.pay('cs_test_m1');
  assert.deepEqual(await (await post(s.base, '/merch/confirm', { sessionId: 'cs_test_m1' })).json(), { paid: true });
  await post(s.base, '/merch/confirm', { sessionId: 'cs_test_m1' });
  await s.merch.sync();
  assert.equal(s.orders.length, 1);
  const { order, confirm } = s.orders[0];
  assert.equal(confirm, false);
  assert.equal(order.external_id, externalId('cs_test_m1'));
  assert.equal(order.external_id.length, 32);
  assert.deepEqual(order.items, [{ sync_variant_id: 101, quantity: 1 }]);
  assert.equal(order.recipient.zip, '11201');
  assert.equal(order.recipient.state_code, 'NY');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].subject, /Merch sold: Ex Boyfriend Tee \(Black \/ M\) for 36\.00 USD/);
  assert.match(s.sent[0].text, /draft order 9001/);
});

test('live keys confirm the Printful order straight away', async (t) => {
  const s = setup({ STRIPE_SECRET_KEY: 'sk_live_1' }); t.after(() => s.server.close());
  await post(s.base, '/merch/checkout', { variant: 101 });
  s.pay('cs_test_m1');
  await post(s.base, '/merch/confirm', { sessionId: 'cs_test_m1' });
  assert.equal(s.orders[0].confirm, true);
});

test('the two-minute check sends paid checkouts the buyer never came back from', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  await post(s.base, '/merch/checkout', { variant: 101 });
  s.pay('cs_test_m1');
  await s.merch.sync();
  await s.merch.sync();
  assert.equal(s.orders.length, 1);
});

test('if Printful turns it away, jo hears about it and it is tried again', async (t) => {
  const s = setup(); t.after(() => s.server.close());
  await post(s.base, '/merch/checkout', { variant: 101 });
  s.pay('cs_test_m1');
  const e = new Error('Printful said 400: Recipient address is invalid'); e.reason = 'Recipient address is invalid';
  s.fail(e);
  await post(s.base, '/merch/confirm', { sessionId: 'cs_test_m1' });
  assert.equal(s.orders.length, 0);
  assert.match(s.sent[0].subject, /didn't reach Printful/);
  await s.merch.sync();
  assert.equal(s.orders.length, 1);
});

test('the Printful client sends the token and store, and reads errors', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 401, json: async () => ({ code: 401, error: { message: 'Malformed token' } }) }; };
  const pf = printfulClient({ token: 'tok', storeId: '42', fetch: f });
  await assert.rejects(pf.createOrder({}, true), /401: Malformed token/);
  assert.equal(calls[0].url, 'https://api.printful.com/orders?confirm=true');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['x-pf-store-id'], '42');
});

test('a secret key in STRIPE_PUBLISHABLE_KEY is never sent to browsers', async (t) => {
  const s = setup({ STRIPE_PUBLISHABLE_KEY: 'sk_test_oops' }); t.after(() => s.server.close());
  const body = await (await fetch(s.base + '/merch')).text();
  assert.doesNotMatch(body, /sk_test_oops/);
  assert.deepEqual(JSON.parse(body), { open: false, products: [] });
});
