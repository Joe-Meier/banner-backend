require('dotenv').config();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { createApp, readConfig } = require('./app');

const config = readConfig(process.env);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const mailer = process.env.EMAIL_USER && process.env.EMAIL_PASS
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } })
  : null;

if (!(config.pricePerBlock > 0)) console.warn('PRICE_PER_BLOCK is not set, so checkout is closed.');
if (!config.webhookSecret) console.warn('STRIPE_WEBHOOK_SECRET is not set, so you will not hear about sales.');
if (!mailer) console.warn('EMAIL_USER / EMAIL_PASS are not set, so sale emails only go to the log.');

const PORT = process.env.PORT || 3000;
createApp({ stripe, mailer, config }).listen(PORT, () => {
  console.log(`🚀 Banner backend running on port ${PORT}`);
});
