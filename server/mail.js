/**
 * Sending email (password reset links). Set on the website's host (Render → Environment) or
 * before starting the dashboard:
 *
 *   GMAIL_USER          the Gmail address it sends from, e.g. wavs.dashboard@gmail.com
 *   GMAIL_APP_PASSWORD  an app password for that account (Google Account → Security →
 *                       2-Step Verification on → App passwords). Not the normal password.
 *
 * Or any other mail service: SMTP_URL=smtps://user:pass@smtp.example.com:465 and MAIL_FROM.
 * MAIL_TRANSPORT=log prints emails to the log instead of sending them (for testing).
 * Without any of these, email is off and the sign-in page says to ask an admin.
 */
export function mailConfig(env = process.env) {
  if (env.MAIL_TRANSPORT === 'log') return { kind: 'log', from: env.MAIL_FROM || 'WAVS Dashboard <noreply@localhost>' };
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return {
      kind: 'gmail',
      from: env.MAIL_FROM || `WAVS Dashboard <${env.GMAIL_USER}>`,
      transport: { service: 'gmail', auth: { user: env.GMAIL_USER, pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') } },
    };
  }
  if (env.SMTP_URL) return { kind: 'smtp', from: env.MAIL_FROM || 'WAVS Dashboard <noreply@localhost>', transport: env.SMTP_URL };
  return null;
}

export class Mailer {
  constructor(config = mailConfig()) {
    this.config = config;
    this.sent = []; // MAIL_TRANSPORT=log: the last few, for tests
  }

  get enabled() { return Boolean(this.config); }

  async send({ to, subject, text, html }) {
    if (!this.config) throw new Error('Email isn\'t set up on this dashboard');
    const msg = { from: this.config.from, to, subject, text, html };
    if (this.config.kind === 'log') {
      this.sent = [...this.sent.slice(-9), msg];
      console.log(`[mail] to ${to}: ${subject}\n${text}`);
      return;
    }
    this.transport ||= (await import('nodemailer')).default.createTransport(this.config.transport);
    await this.transport.sendMail(msg);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The password reset email. */
export function resetEmail({ name, link, site = 'WAVS Dashboard', minutes = 60 }) {
  const text = `Hi ${name},

Someone (hopefully you) asked to reset your ${site} password. Open this link to choose a new one:

${link}

It works once, for the next ${minutes} minutes. If you didn't ask for this, ignore this email; your password stays the same.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p>Hi ${esc(name)},</p>
<p>Someone (hopefully you) asked to reset your ${esc(site)} password.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p style="color:#555;font-size:13px">It works once, for the next ${minutes} minutes. If you didn't ask for this, ignore this email; your password stays the same.<br>Link not working? Copy this into your browser: ${esc(link)}</p>
</div>`;
  return { subject: `Reset your ${site} password`, text, html };
}
