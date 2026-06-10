const nodemailer = require('nodemailer');

const smtpPort = Number(process.env.SMTP_PORT || 587);

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

module.exports = mailer;
