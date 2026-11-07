// Sale emails. Render's free plan blocks the ports Gmail's SMTP needs, so on Render the server sends through
// Resend's web API instead (free; set RESEND_API_KEY). Gmail SMTP still works on hosts that allow it.
const nodemailer = require('nodemailer');

function resendMailer({ apiKey, from = 'Banner <onboarding@resend.dev>', fetch = globalThis.fetch }) {
  return {
    async sendMail({ to, subject, text, attachments = [] }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [to], subject, text,
          attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }))
        })
      });
      if (!res.ok) throw new Error(`Resend said ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json();
    }
  };
}

function makeMailer(env) {
  if (env.RESEND_API_KEY) return resendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM || undefined });
  if (env.EMAIL_USER && env.EMAIL_PASS) {
    return nodemailer.createTransport({ service: 'gmail', auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS }, connectionTimeout: 15000, greetingTimeout: 15000 });
  }
  return null;
}

module.exports = { makeMailer, resendMailer };
