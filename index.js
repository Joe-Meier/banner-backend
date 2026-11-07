require('dotenv').config();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { createApp, readConfig } = require('./app');
const { memoryStore, githubStore } = require('./store');

const env = process.env;
const config = readConfig(env);
const stripe = Stripe(env.STRIPE_SECRET_KEY);
const mailer = env.EMAIL_USER && env.EMAIL_PASS
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS } })
  : null;
const store = env.GITHUB_TOKEN && env.ORDERS_REPO
  ? githubStore({ token: env.GITHUB_TOKEN, ordersRepo: env.ORDERS_REPO, siteRepo: env.SITE_REPO || 'Joe-Meier/Joecool', siteBranch: env.SITE_BRANCH || 'main' })
  : memoryStore();

if (!(config.pricePerBlock > 0)) console.warn('PRICE_PER_BLOCK is not set, so checkout is closed.');
if (!config.webhookSecret) console.warn('STRIPE_WEBHOOK_SECRET is not set, so paid orders never show up for approval.');
if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set, so the /admin page is locked.');
if (!(env.GITHUB_TOKEN && env.ORDERS_REPO)) console.warn('GITHUB_TOKEN / ORDERS_REPO are not set, so orders only live in memory and approved ads never reach the site.');
if (!mailer) console.warn('EMAIL_USER / EMAIL_PASS are not set, so sale emails only go to the log.');

const PORT = env.PORT || 3000;
createApp({ stripe, mailer, store, config }).listen(PORT, () => {
  console.log(`🚀 Banner backend running on port ${PORT}`);
});
