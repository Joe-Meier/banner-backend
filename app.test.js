const test = require('node:test');
const assert = require('node:assert');
const { createApp, readConfig } = require('./app');

// A 1×1 PNG, as the site would send it.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function setup(env = {}) {
  const created = [], sent = [];
  const stripe = {
    checkout: { sessions: { create: async (params) => { created.push(params); return { id: 'cs_test_abc12345', url: 'https://checkout.stripe.com/c/pay/cs_test_abc12345' }; } } },
    webhooks: {
      constructEvent: (body, sig) => {
        if (sig !== 'good') throw new Error('bad sig');
        return JSON.parse(body.toString());
      }
    }
  };
  const mailer = { sendMail: async (m) => { sent.push(m); } };
  const config = readConfig({ PRICE_PER_BLOCK: '25', STRIPE_WEBHOOK_SECRET: 'whsec_x', EMAIL_USER: 'jo@example.com', ...env });
  const quiet = { info() {}, warn() {}, error() {} };
  const server = createApp({ stripe, mailer, config, log: quiet }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { created, sent, server, base };
}
const order = (over = {}) => ({
  customer: { name: 'Ada', email: 'ada@example.com', company: 'Acme', url: 'https://acme.test' },
  selection: { x: 2, y: 1, width: 5, height: 3, cost: 1 },
  image: PNG,
  ...over
});
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the server sets the price, whatever the browser says it costs', async () => {
  const { created, server, base } = setup();
  const res = await post(base, '/create-checkout-session', order());
  const json = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.equal(json.url, 'https://checkout.stripe.com/c/pay/cs_test_abc12345');
  assert.equal(json.total, 375);
  const li = created[0].line_items[0];
  assert.equal(li.quantity, 15);
  assert.equal(li.price_data.unit_amount, 2500);
  assert.equal(created[0].metadata.spot_blocks, '15');
  assert.equal(created[0].success_url, 'https://joe-meier.github.io/Joecool/?banner=paid#banner');
});

test('spots off the banner, bad emails and missing images are turned away', async () => {
  const { created, server, base } = setup();
  const off = await post(base, '/create-checkout-session', order({ selection: { x: 30, y: 0, width: 5, height: 1 } }));
  const email = await post(base, '/create-checkout-session', order({ customer: { name: 'Ada', email: 'nope' } }));
  const img = await post(base, '/create-checkout-session', order({ image: 'data:text/html;base64,PGgxPg==' }));
  server.close();
  assert.deepEqual([off.status, email.status, img.status], [400, 400, 400]);
  assert.equal(created.length, 0);
});

test('checkout is closed when no price is set', async () => {
  const { server, base } = setup({ PRICE_PER_BLOCK: '' });
  const res = await post(base, '/create-checkout-session', order());
  const cfg = await (await fetch(base + '/config')).json();
  server.close();
  assert.equal(res.status, 503);
  assert.equal(cfg.pricePerBlock, null);
});

test('a paid checkout emails jo the spot, the buyer and their ad', async () => {
  const { sent, server, base } = setup();
  await post(base, '/create-checkout-session', order());
  const event = { type: 'checkout.session.completed', data: { object: {
    id: 'cs_test_abc12345', payment_status: 'paid', amount_total: 37500, currency: 'usd', customer_email: 'ada@example.com',
    metadata: { customer_name: 'Ada', customer_company: 'Acme', customer_url: 'https://acme.test', spot_x: '2', spot_y: '1', spot_width: '5', spot_height: '3', spot_blocks: '15' }
  } } };
  const bad = await post(base, '/webhook', event, { 'stripe-signature': 'forged' });
  const good = await post(base, '/webhook', event, { 'stripe-signature': 'good' });
  server.close();
  assert.equal(bad.status, 400);
  assert.equal(good.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /5 × 3 for 375\.00 USD/);
  assert.match(sent[0].text, /starting 3 across, 2 down/);
  assert.match(sent[0].text, /x: 2, y: 1, w: 5, h: 3/);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].contentType, 'image/png');
});
