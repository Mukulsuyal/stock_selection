// server/mailer.js
// Optional email sender for triggered alerts. If SMTP env vars are not set,
// it silently no-ops (logs to console instead) so the app works out of the box.
const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendAlertEmail(to, subject, text) {
  if (!transporter) {
    console.log(`[mailer] (SMTP not configured) Would send to ${to}: ${subject} - ${text}`);
    return { skipped: true };
  }
  return transporter.sendMail({
    from: process.env.ALERT_FROM_EMAIL || 'alerts@stockanalyzer.local',
    to,
    subject,
    text,
  });
}

module.exports = { sendAlertEmail };
