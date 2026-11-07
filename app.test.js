const test = require('node:test');
const assert = require('node:assert');
const { createApp, readConfig } = require('./app');
const { memoryStore, githubStore } = require('./store');

// A 1×1 PNG, as the site would send it.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const quiet = { info() {}, warn() {}, error() {} };

function setup(env = {}) {
  const created = [], sent = [], refunds = [];
  let n = 0;
  const stripe = {
    checkout: { sessions: { create: async (params) => { created.push(params); n++; return { id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` }; } } },
    refunds: { create: async (params) => { refunds.push(params); return { id: 're_1' }; } },
    webhooks: {
      constructEvent: (body, sig) => {
        if (sig !== 'good') throw new Error('bad sig');
        return JSON.parse(body.toString());
      }
    }
  };
  const mailer = { sendMail: async (m) => { sent.push(m); } };
  const store = memoryStore();
  const config = readConfig({ PRICE_PER_BLOCK: '3', STRIPE_WEBHOOK_SECRET: 'whsec_x', EMAIL_USER: 'jo@example.com', ADMIN_PASSWORD: 'hunter2', PUBLIC_URL: 'https://banner.test', ...env });
  const server = createApp({ stripe, mailer, store, config, log: quiet }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { created, sent, refunds, store, server, base };
}
const order = (over = {}) => ({
  customer: { name: 'Ada', email: 'ada@example.com', company: 'Acme', url: 'https://acme.test' },
  selection: { x: 2, y: 1, width: 5, height: 3, cost: 1 },
  image: PNG,
  ...over
});
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const JO = { authorization: 'Basic ' + Buffer.from('jo:hunter2').toString('base64') };
const ADMIN = { ...JO, 'x-banner-admin': '1' };
const paid = (orderId, sessionId = 'cs_test_1') => ({ type: 'checkout.session.completed', data: { object: {
  id: sessionId, payment_status: 'paid', amount_total: 4500, currency: 'usd', payment_intent: 'pi_123', metadata: { order_id: orderId }
} } });
async function buy(t, body = order()) {
  await post(t.base, '/create-checkout-session', body);
  const id = t.created[t.created.length - 1].metadata.order_id;
  await post(t.base, '/webhook', paid(id, `cs_test_${t.created.length}`), { 'stripe-signature': 'good' });
  return id;
}

test('the server sets the price and keeps the ad, whatever the browser says it costs', async () => {
  const t = setup();
  const res = await post(t.base, '/create-checkout-session', order());
  const json = await res.json();
  t.server.close();
  assert.equal(res.status, 200);
  assert.equal(json.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(json.total, 45);
  const li = t.created[0].line_items[0];
  assert.equal(li.quantity, 15);
  assert.equal(li.price_data.unit_amount, 300);
  assert.equal(t.created[0].success_url, 'https://joe-meier.github.io/Joecool/?banner=paid#banner');
  const [saved] = await t.store.listOrders();
  assert.equal(saved.status, 'unpaid');
  assert.equal(saved.id, t.created[0].metadata.order_id);
  assert.equal(saved.sessionId, 'cs_test_1');
  assert.equal((await t.store.getImage(saved)).contentType, 'image/png');
});

test('spots off the banner, bad emails and missing images are turned away', async () => {
  const t = setup();
  const off = await post(t.base, '/create-checkout-session', order({ selection: { x: 62, y: 0, width: 5, height: 1 } }));
  const low = await post(t.base, '/create-checkout-session', order({ selection: { x: 0, y: 18, width: 2, height: 3 } }));
  const email = await post(t.base, '/create-checkout-session', order({ customer: { name: 'Ada', email: 'nope' } }));
  const img = await post(t.base, '/create-checkout-session', order({ image: 'data:text/html;base64,PGgxPg==' }));
  t.server.close();
  assert.deepEqual([off.status, low.status, email.status, img.status], [400, 400, 400, 400]);
  assert.equal(t.created.length, 0);
});

test('checkout is closed when no price is set', async () => {
  const t = setup({ PRICE_PER_BLOCK: '' });
  const res = await post(t.base, '/create-checkout-session', order());
  const cfg = await (await fetch(t.base + '/config')).json();
  t.server.close();
  assert.equal(res.status, 503);
  assert.equal(cfg.pricePerBlock, null);
  assert.equal(cfg.rows, 20);
});

test('a paid order waits for jo, and jo gets an email with the ad and a link to approve it', async () => {
  const t = setup();
  await post(t.base, '/create-checkout-session', order());
  const id = t.created[0].metadata.order_id;
  const bad = await post(t.base, '/webhook', paid(id), { 'stripe-signature': 'forged' });
  const good = await post(t.base, '/webhook', paid(id), { 'stripe-signature': 'good' });
  const again = await post(t.base, '/webhook', paid(id), { 'stripe-signature': 'good' });
  t.server.close();
  assert.deepEqual([bad.status, good.status, again.status], [400, 200, 200]);
  const o = await t.store.getOrder(id);
  assert.equal(o.status, 'paid');
  assert.equal(o.paymentIntent, 'pi_123');
  assert.equal(t.sent.length, 1, 'one email, even if Stripe sends the event twice');
  assert.match(t.sent[0].subject, /5 × 3 for 45\.00 USD/);
  assert.match(t.sent[0].text, /https:\/\/banner\.test\/admin/);
  assert.equal(t.sent[0].attachments[0].contentType, 'image/png');
});

test('nobody can buy a spot that is taken or waiting for approval', async () => {
  const t = setup();
  await buy(t);
  const overlap = await post(t.base, '/create-checkout-session', order({ selection: { x: 6, y: 3, width: 4, height: 2 } }));
  const beside = await post(t.base, '/create-checkout-session', order({ selection: { x: 7, y: 1, width: 4, height: 2 } }));
  t.server.close();
  assert.equal(overlap.status, 409);
  assert.equal(beside.status, 200);
});

test('the admin page is just for jo', async () => {
  const t = setup();
  const none = await fetch(t.base + '/admin');
  const wrong = await fetch(t.base + '/admin', { headers: { authorization: 'Basic ' + Buffer.from('jo:nope').toString('base64') } });
  const right = await fetch(t.base + '/admin', { headers: JO });
  const api = await fetch(t.base + '/admin/api/orders');
  t.server.close();
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /Basic/);
  assert.equal(wrong.status, 401);
  assert.equal(right.status, 200);
  assert.match(await right.text(), /Banner orders/);
  assert.equal(api.status, 401);
});

test('approving puts the ad on the banner; refunding and taking down work too', async () => {
  const t = setup();
  const first = await buy(t);
  const second = await buy(t, order({ selection: { x: 20, y: 0, width: 2, height: 2 } }));

  const list = await (await fetch(t.base + '/admin/api/orders', { headers: JO })).json();
  assert.deepEqual(list.orders.map((o) => o.status), ['paid', 'paid']);
  const img = await fetch(`${t.base}/admin/api/orders/${first}/image`, { headers: JO });
  assert.equal(img.headers.get('content-type'), 'image/png');

  const noHeader = await post(t.base, `/admin/api/orders/${first}/approve`, {}, JO);
  assert.equal(noHeader.status, 403, 'buttons only work from the admin page');

  const ok = await post(t.base, `/admin/api/orders/${first}/approve`, {}, ADMIN);
  assert.equal(ok.status, 200);
  const ads = await t.store.listAds();
  assert.equal(ads.length, 1);
  assert.deepEqual({ ...ads[0], until: undefined }, { id: first, x: 2, y: 1, w: 5, h: 3, image: `banner/${first}.png`, url: 'https://acme.test', name: 'Acme', until: undefined });
  assert.equal((await t.store.getOrder(first)).status, 'live');
  assert.equal((await post(t.base, `/admin/api/orders/${first}/approve`, {}, ADMIN)).status, 409, 'no approving twice');

  const refund = await post(t.base, `/admin/api/orders/${second}/reject`, {}, ADMIN);
  assert.equal(refund.status, 200);
  assert.deepEqual(t.refunds, [{ payment_intent: 'pi_123' }]);
  assert.equal((await t.store.getOrder(second)).status, 'refunded');

  const down = await post(t.base, `/admin/api/orders/${first}/remove`, {}, ADMIN);
  t.server.close();
  assert.equal(down.status, 200);
  assert.equal((await t.store.listAds()).length, 0);
  assert.equal((await t.store.getOrder(first)).status, 'removed');
});

// A tiny stand-in for GitHub's contents API, with the 409 it sends when two writes cross.
function fakeGitHub() {
  const files = new Map();
  let shaN = 0, crossNext = false;
  const key = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\/repos\//, '').replace('/contents/', ':'));
  const f = async (url, { method, headers, body }) => {
    const k = key(url), file = files.get(k), raw = /raw/.test(headers.accept);
    const json = (status, obj) => new Response(JSON.stringify(obj), { status });
    if (method === 'GET') {
      if (!file) return json(404, { message: 'Not Found' });
      return raw ? new Response(file.content) : json(200, { sha: file.sha, encoding: 'base64', content: file.content.toString('base64') });
    }
    const b = JSON.parse(body);
    if (method === 'DELETE') { files.delete(k); return json(200, {}); }
    if (file && !b.sha) return json(422, { message: '"sha" wasn\'t supplied' });
    if (crossNext || (file && b.sha !== file.sha)) { crossNext = false; return json(409, { message: 'conflict' }); }
    files.set(k, { sha: `s${++shaN}`, content: Buffer.from(b.content, 'base64') });
    return json(200, {});
  };
  return { f, files, cross() { crossNext = true; } };
}

test('the GitHub store keeps orders in the private repo and puts approved ads in the site repo', async () => {
  const gh = fakeGitHub();
  const store = githubStore({ token: 't', ordersRepo: 'jo/banner-orders', siteRepo: 'jo/Joecool', fetch: gh.f });
  const image = { content: Buffer.from('png-bytes'), contentType: 'image/png', ext: 'png' };
  const o = { id: 'abc', status: 'unpaid', spot: { x: 0, y: 0, width: 2, height: 2 }, image: { ext: 'png' }, customer: { name: 'Ada' } };
  await store.putImage(o, image);
  await store.saveOrder(o);
  gh.cross(); // someone else wrote orders.json at the same moment
  await store.updateOrder('abc', { status: 'paid' });
  assert.equal((await store.getOrder('abc')).status, 'paid');
  assert.equal((await store.getImage(o)).content.toString(), 'png-bytes');
  assert.ok(gh.files.has('jo/banner-orders:images/abc.png'));

  await store.publishAd({ id: 'abc', x: 0, y: 0, w: 2, h: 2, image: 'banner/abc.png', name: 'Ada' }, image);
  assert.ok(gh.files.has('jo/Joecool:banner/abc.png'));
  assert.deepEqual((await store.listAds()).map((a) => a.id), ['abc']);
  await store.removeAd('abc');
  assert.deepEqual(await store.listAds(), []);
  assert.ok(!gh.files.has('jo/Joecool:banner/abc.png'));
});
