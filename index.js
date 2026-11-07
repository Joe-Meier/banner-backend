require('dotenv').config();
const Stripe = require('stripe');
const { createApp, readConfig } = require('./app');
const { memoryStore, githubStore } = require('./store');
const { makeMailer } = require('./mailer');

const env = process.env;
const config = readConfig(env);
const stripe = Stripe(env.STRIPE_SECRET_KEY);
const mailer = makeMailer(env);
const ordersRepo = env.ORDERS_REPO || 'Joe-Meier/banner-orders';
const store = env.GITHUB_TOKEN
  ? githubStore({ token: env.GITHUB_TOKEN, ordersRepo, siteRepo: env.SITE_REPO || 'Joe-Meier/Joecool', siteBranch: env.SITE_BRANCH || 'main' })
  : memoryStore();

// On a real server, orders kept in memory would be lost and approved ads would never reach the site,
// so checkout stays closed until the server can keep them.
const hosted = Boolean(env.RAILWAY_ENVIRONMENT || env.RENDER);
if (!env.STRIPE_SECRET_KEY) { config.pricePerBlock = 0; console.warn('STRIPE_SECRET_KEY is not set, so checkout is closed.'); }
if (!env.GITHUB_TOKEN) console.warn(`GITHUB_TOKEN is not set, so orders only live in memory and approved ads never reach the site${hosted ? '. Checkout is closed until it is set.' : '.'}`);
if (hosted && !env.GITHUB_TOKEN) config.pricePerBlock = 0;
if (!(config.pricePerBlock > 0)) console.warn('Checkout is closed.');
if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set, so the /admin page is locked.');
if (!mailer) console.warn('No email set up (RESEND_API_KEY, or EMAIL_USER and EMAIL_PASS), so sale emails only go to the log.');
if (env.RENDER && !env.RESEND_API_KEY && mailer) console.warn("Render's free plan blocks Gmail's SMTP ports, so sale emails won't send. Set RESEND_API_KEY.");
if (mailer && !config.notifyEmail) console.warn('Set NOTIFY_EMAIL (or EMAIL_USER) so sale emails know where to go.');

const PORT = env.PORT || 3000;
const app = createApp({ stripe, mailer, store, config });
app.listen(PORT, () => {
  console.log(`🚀 Banner backend running on port ${PORT}. Orders: ${env.GITHUB_TOKEN ? ordersRepo : 'in memory'}. Price: ${config.pricePerBlock > 0 ? config.pricePerBlock : 'closed'}.`);
});
// Checks Stripe for finished checkouts every two minutes, in case a buyer closed the tab before coming back.
if (env.STRIPE_SECRET_KEY) setInterval(() => app.syncPayments(), 2 * 60 * 1000).unref();
