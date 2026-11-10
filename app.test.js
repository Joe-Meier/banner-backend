const test = require('node:test');
const assert = require('node:assert');
const { createApp, readConfig } = require('./app');
const { memoryStore, githubStore } = require('./store');
const { resendMailer } = require('./mailer');
const { instagramFeed } = require('./instagram');

// A 1×1 PNG, as the site would send it.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const quiet = { info() {}, warn() {}, error() {} };

function setup(env = {}, extra = {}) {
  const created = [], sent = [], refunds = [], sessions = new Map();
  let n = 0;
  const stripe = {
    checkout: { sessions: {
      create: async (params) => {
        created.push(params); n++;
        const s = { id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, status: 'open', payment_status: 'unpaid', metadata: params.metadata, currency: 'usd' };
        sessions.set(s.id, s);
        return s;
      },
      retrieve: async (id) => { if (!sessions.has(id)) throw new Error('No such checkout.session'); return { ...sessions.get(id) }; }
    } },
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
  const server = createApp({ stripe, mailer, store, config, log: quiet, ...extra }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // What happens on Stripe's side when the buyer pays, without telling the server.
  const pay = (id) => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', amount_total: 4500, payment_intent: 'pi_456' });
  return { created, sent, refunds, store, server, base, pay };
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
  assert.equal(t.created[0].success_url, 'https://joe-meier.github.io/Joecool/?banner=paid&session_id={CHECKOUT_SESSION_ID}#banner');
  const [saved] = await t.store.listOrders();
  assert.equal(saved.status, 'unpaid');
  assert.equal(saved.id, t.created[0].metadata.order_id);
  assert.equal(saved.sessionId, 'cs_test_1');
  assert.equal((await t.store.getImage(saved)).contentType, 'image/png');
});

test('spots off the banner, bad emails and missing images are turned away', async () => {
  const t = setup();
  const off = await post(t.base, '/create-checkout-session', order({ selection: { x: 8, y: 0, width: 5, height: 1 } }));
  const low = await post(t.base, '/create-checkout-session', order({ selection: { x: 0, y: 248, width: 2, height: 3 } }));
  const email = await post(t.base, '/create-checkout-session', order({ customer: { name: 'Ada', email: 'nope' } }));
  const img = await post(t.base, '/create-checkout-session', order({ image: 'data:text/html;base64,PGgxPg==' }));
  t.server.close();
  assert.deepEqual([off.status, low.status, email.status, img.status], [400, 400, 400, 400]);
  assert.equal(t.created.length, 0);
});

test('checkout is closed when no price is set', async () => {
  const t = setup({ PRICE_PER_BLOCK: '0' });
  const res = await post(t.base, '/create-checkout-session', order());
  const cfg = await (await fetch(t.base + '/config')).json();
  t.server.close();
  assert.equal(res.status, 503);
  assert.equal(cfg.pricePerBlock, null);
  assert.equal(cfg.cols, 10);
  assert.equal(cfg.rows, 250);
  assert.equal(cfg.termMonths, 3);
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

test('without the webhook, the server asks Stripe itself: when the buyer comes back, and when jo opens the page', async () => {
  const t = setup({ STRIPE_WEBHOOK_SECRET: '' });
  await post(t.base, '/create-checkout-session', order());
  await post(t.base, '/create-checkout-session', order({ selection: { x: 0, y: 30, width: 2, height: 2 } }));
  const [a, b] = t.created.map((c) => c.metadata.order_id);
  t.pay('cs_test_1');
  const back = await post(t.base, '/confirm', { sessionId: 'cs_test_1' });
  const junk = await post(t.base, '/confirm', { sessionId: '../etc' });
  assert.deepEqual([back.status, junk.status], [200, 400]);
  assert.equal((await t.store.getOrder(a)).status, 'paid');
  assert.equal((await t.store.getOrder(a)).paymentIntent, 'pi_456');
  assert.equal(t.sent.length, 1);

  t.pay('cs_test_2'); // this buyer closed the tab instead of coming back
  const list = await (await fetch(t.base + '/admin/api/orders', { headers: JO })).json();
  await post(t.base, '/confirm', { sessionId: 'cs_test_1' });
  t.server.close();
  assert.deepEqual(list.orders.map((o) => o.status).sort(), ['paid', 'paid']);
  assert.equal((await t.store.getOrder(b)).status, 'paid');
  assert.equal(t.sent.length, 2, 'one email per sale');
});

test('nobody can buy a spot that is taken or waiting for approval', async () => {
  const t = setup();
  await buy(t);
  const overlap = await post(t.base, '/create-checkout-session', order({ selection: { x: 6, y: 3, width: 4, height: 2 } }));
  const beside = await post(t.base, '/create-checkout-session', order({ selection: { x: 7, y: 1, width: 3, height: 2 } }));
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
  const second = await buy(t, order({ selection: { x: 0, y: 20, width: 2, height: 2 } }));

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

test('on Render, sale emails go through Resend with the ad attached', async () => {
  const calls = [];
  const mailer = resendMailer({ apiKey: 're_123', fetch: async (url, opts) => { calls.push({ url, opts }); return new Response('{"id":"e1"}', { status: 200 }); } });
  await mailer.sendMail({ to: 'jo@example.com', subject: 'Banner spot sold', text: 'hi', attachments: [{ filename: 'ad.png', content: Buffer.from('png-bytes'), contentType: 'image/png' }] });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer re_123');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.to, ['jo@example.com']);
  assert.equal(body.from, 'Banner <onboarding@resend.dev>');
  assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString(), 'png-bytes');
  const failing = resendMailer({ apiKey: 'x', fetch: async () => new Response('nope', { status: 403 }) });
  await assert.rejects(failing.sendMail({ to: 'a@b.c', subject: 's', text: 't' }), /Resend said 403/);
});

test('checkout answers the site on joemeier.cool and on GitHub, and nobody else', async () => {
  const t = setup();
  const ask = (origin) => fetch(t.base + '/config', { headers: { Origin: origin } }).then((r) => r.headers.get('access-control-allow-origin'));
  const [custom, www, github, other] = await Promise.all(['https://joemeier.cool', 'https://www.joemeier.cool', 'https://joe-meier.github.io', 'https://evil.test'].map(ask));
  t.server.close();
  assert.deepEqual([custom, www, github, other], ['https://joemeier.cool', 'https://www.joemeier.cool', 'https://joe-meier.github.io', null]);
});

test('slop submissions: the photo and the note get emailed to jo, and the note is optional', async () => {
  const t = setup();
  const withNote = await post(t.base, '/slop', { image: PNG, blurb: 'A deli on 2nd Ave.\nThe bacon has fingers.' });
  const bare = await post(t.base, '/slop', { image: PNG });
  const none = await post(t.base, '/slop', { blurb: 'no photo' });
  const html = await post(t.base, '/slop', { image: 'data:text/html;base64,PGgxPg==' });
  const bot = await post(t.base, '/slop', { image: PNG, website: 'spam.test' });
  t.server.close();
  assert.deepEqual([withNote.status, bare.status, none.status, html.status, bot.status], [200, 200, 400, 400, 200]);
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0].to, 'jo@example.com');
  assert.equal(t.sent[0].subject, 'Slop submission: A deli on 2nd Ave.');
  assert.match(t.sent[0].text, /The bacon has fingers\./);
  assert.match(t.sent[0].attachments[0].filename, /^slop-[0-9a-f]{8}\.png$/);
  assert.equal(t.sent[1].subject, 'Slop submission');
  assert.match(t.sent[1].text, /didn't write anything/);
});

test('slop submissions slow down after a few from the same visitor, and close without email', async () => {
  const t = setup();
  const from = (ip) => fetch(t.base + '/slop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ image: PNG }) }).then((r) => r.status);
  const first = [];
  for (let i = 0; i < 6; i++) first.push(await from('203.0.113.7'));
  const other = await from('198.51.100.2');
  t.server.close();
  assert.deepEqual(first, [200, 200, 200, 200, 200, 429]);
  assert.equal(other, 200);
  const off = setup({ EMAIL_USER: '' });
  const closed = await post(off.base, '/slop', { image: PNG });
  off.server.close();
  assert.equal(closed.status, 503);
});

/* ---------- Instagram ---------- */
// A pretend internet: answers by URL, and remembers what was asked.
function fakeFetch(routes) {
  const asked = [];
  const f = async (url) => {
    asked.push(url);
    for (const [match, answer] of routes) {
      if (url.includes(match)) {
        const { status = 200, body, type = 'application/json', bytes } = typeof answer === 'function' ? answer(url) : answer;
        return {
          ok: status < 400, status, headers: new Headers({ 'content-type': type }),
          json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array(bytes || []).buffer
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  return { f, asked };
}

const beholdPost = (n, extra = {}) => ({
  id: String(n), permalink: `https://www.instagram.com/p/post${n}/`, mediaType: 'IMAGE', timestamp: `2026-11-0${n}T12:00:00+0000`,
  mediaUrl: `https://cdn.behold.test/${n}-full.jpg`, sizes: { medium: { mediaUrl: `https://cdn.behold.test/${n}-medium.jpg`, width: 700, height: 875 } },
  caption: `Post ${n}`, prunedCaption: `Post ${n}`, ...extra
});

test('the Instagram section gets the latest three posts from a Behold feed, and the server only asks every half hour', async () => {
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const { f, asked } = fakeFetch([['feeds.behold.test', { body: { username: 'brunch666', posts: [
    beholdPost(5, { mediaType: 'VIDEO', sizes: undefined, thumbnailUrl: 'https://cdn.behold.test/5-still.jpg' }),
    beholdPost(4, { permalink: 'javascript:alert(1)' }),
    beholdPost(3), beholdPost(2), beholdPost(1)
  ] } }]]);
  const instagram = instagramFeed({ feedUrl: 'https://feeds.behold.test/abc', fetch: f, log: quiet, now: () => clock });
  const t = setup({}, { instagram });
  try {
    const res = await fetch(t.base + '/instagram', { headers: { origin: 'https://joemeier.cool' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://joemeier.cool');
    const feed = await res.json();
    assert.strictEqual(feed.username, 'brunch666');
    assert.deepStrictEqual(feed.posts.map((p) => [p.url, p.image, p.type]), [
      ['https://www.instagram.com/p/post5/', 'https://cdn.behold.test/5-still.jpg', 'video'],
      ['https://www.instagram.com/p/post3/', 'https://cdn.behold.test/3-medium.jpg', 'image'],
      ['https://www.instagram.com/p/post2/', 'https://cdn.behold.test/2-medium.jpg', 'image']
    ]);
    await fetch(t.base + '/instagram');
    assert.strictEqual(asked.length, 1, 'a second visitor gets the saved feed');
    clock += 31 * 60 * 1000;
    await fetch(t.base + '/instagram');
    assert.strictEqual(asked.length, 2, 'half an hour later it asks again');
  } finally { t.server.close(); }
});

test('with a token for Instagram\'s own API, the server renews it weekly and keeps the new one', async () => {
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const store = memoryStore();
  const media = () => ({ body: { data: [
    { id: '1', media_type: 'CAROUSEL_ALBUM', media_url: 'https://scontent.test/1.jpg', permalink: 'https://www.instagram.com/p/one/', timestamp: '2026-11-09T10:00:00+0000', caption: 'one' },
    { id: '2', media_type: 'VIDEO', media_url: 'https://scontent.test/2.mp4', thumbnail_url: 'https://scontent.test/2.jpg', permalink: 'https://www.instagram.com/reel/two/', timestamp: '2026-11-08T10:00:00+0000' },
    { id: '3', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/three/', timestamp: '2026-11-07T10:00:00+0000' }, // licensed music: no picture
    { id: '4', media_type: 'IMAGE', media_url: 'https://scontent.test/4.jpg', permalink: 'https://www.instagram.com/p/four/', timestamp: '2026-11-06T10:00:00+0000' }
  ] } });
  const { f, asked } = fakeFetch([
    ['refresh_access_token', { body: { access_token: 'IGtoken-2', token_type: 'bearer', expires_in: 5184000 } }],
    ['/me/media', media],
    ['scontent.test/4.jpg', { status: 403, body: {} }],
    ['scontent.test/', (url) => ({ type: 'image/jpeg', bytes: [0xff, 0xd8, url.length] })]
  ]);
  const feed = instagramFeed({ token: 'IGtoken-1', store, fetch: f, log: quiet, now: () => clock });
  const first = await feed.latest();
  // The server keeps its own copies of Instagram's pictures. One that won't download links to Instagram's copy.
  assert.deepStrictEqual(first.posts.map((p) => [p.url, p.image, p.type]), [
    ['https://www.instagram.com/p/one/', '/instagram/img/1', 'carousel'],
    ['https://www.instagram.com/reel/two/', '/instagram/img/2', 'video'],
    ['https://www.instagram.com/p/four/', 'https://scontent.test/4.jpg', 'image']
  ]);
  const t = setup({}, { instagram: feed });
  try {
    const pic = await fetch(t.base + '/instagram/img/2');
    assert.strictEqual(pic.headers.get('content-type'), 'image/jpeg');
    assert.deepStrictEqual([...new Uint8Array(await pic.arrayBuffer())], [0xff, 0xd8, 'https://scontent.test/2.jpg'.length]);
    assert.strictEqual((await fetch(t.base + '/instagram/img/4')).status, 404);
  } finally { t.server.close(); }
  assert.match(asked[0], /^https:\/\/graph\.instagram\.com\/me\/media\?fields=[a-z_,]*permalink[a-z_,]*&limit=\d+&access_token=IGtoken-1$/);
  await new Promise((r) => setImmediate(r));
  assert.ok(asked.some((u) => u.includes('refresh_access_token') && u.includes('IGtoken-1')), 'it renews the token');
  assert.strictEqual((await store.getSetting('instagram')).token, 'IGtoken-2', 'and keeps the new one');

  // After a restart, the server picks up the renewed token...
  const again = fakeFetch([['/me/media', media]]);
  await instagramFeed({ token: 'IGtoken-1', store, fetch: again.f, log: quiet, now: () => clock }).latest();
  assert.match(again.asked[0], /access_token=IGtoken-2$/);
  // ...unless jo has pasted a different token into Render since.
  const fresh = fakeFetch([['/me/media', media]]);
  await instagramFeed({ token: 'IGtoken-new', store, fetch: fresh.f, log: quiet, now: () => clock }).latest();
  assert.match(fresh.asked[0], /access_token=IGtoken-new$/);
});

test('if Instagram is down, visitors get the last posts the server had, and with none, an error the site can work with', async () => {
  let clock = Date.parse('2026-11-10T12:00:00Z'), down = false;
  const { f } = fakeFetch([['feeds.behold.test', () => (down ? { status: 500, body: {} } : { body: { posts: [beholdPost(1)] } })]]);
  const feed = instagramFeed({ feedUrl: 'https://feeds.behold.test/abc', fetch: f, log: quiet, now: () => clock });
  await feed.latest();
  down = true; clock += 31 * 60 * 1000;
  assert.strictEqual((await feed.latest()).posts.length, 1);

  const broken = instagramFeed({ feedUrl: 'https://feeds.behold.test/abc', fetch: f, log: quiet, now: () => clock });
  const t = setup({}, { instagram: broken });
  const none = setup();
  try {
    assert.strictEqual((await fetch(t.base + '/instagram')).status, 502);
    assert.strictEqual((await fetch(none.base + '/instagram')).status, 404, 'no feed set up');
  } finally { t.server.close(); none.server.close(); }
});
