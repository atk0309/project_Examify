import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import { allowLocalMailOutbox, env, isResendConfigured, resolveMailTransport } from '@/lib/env';
import { sendSmtp, type SendResult } from './smtp';

export type { SendResult };

const resend = isResendConfigured() ? new Resend(env.RESEND_API_KEY!) : null;

function resolveOutboxDir(): string {
  const configured = env.MAIL_OUTBOX_DIR;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(/*turbopackIgnore: true*/ process.cwd(), configured);
  }
  // `RESEND_API_KEY=test` in dev/test keeps the existing outbox so e2e can
  // poll it (Playwright also sets ALLOW_LOCAL_OUTBOX=1 under NODE_ENV=production).
  // A real production deploy with no key writes to the data volume instead,
  // and only if ALLOW_LOCAL_OUTBOX is set.
  if (env.RESEND_API_KEY === 'test' || env.NODE_ENV === 'test') {
    return path.join(process.cwd(), 'tests', '.tmp', 'outbox');
  }
  return path.join(process.cwd(), 'data', 'outbox');
}

async function writeTestOutbox(payload: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  code?: string;
}): Promise<string> {
  const dest = resolveOutboxDir();
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  await fs.chmod(dest, 0o700);
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dest, `${id}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ ...payload, sentAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return id;
}

async function sendViaOutbox(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  code?: string;
}): Promise<SendResult> {
  if (!allowLocalMailOutbox()) {
    console.error(
      '[email] no mail transport configured; refusing to write magic-link tokens to a local outbox',
    );
    return { ok: false, error: 'email-not-configured' };
  }
  try {
    const id = await writeTestOutbox({
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      code: options.code,
    });
    return { ok: true, id };
  } catch (error) {
    console.error('[email] local outbox write failed', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'outbox write failed',
    };
  }
}

/**
 * Send a message through the resolved SMTP, Resend, or local-outbox transport.
 * The separate local-OTP `code` field is copied only to outbox JSON so the
 * host can read it; SMTP and Resend receive the rendered message body.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Local-OTP digit string; stored on the outbox JSON so a host can read it. */
  code?: string;
}): Promise<SendResult> {
  const transport = resolveMailTransport();

  if (transport === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_FROM) {
      return { ok: false, error: 'SMTP is not fully configured' };
    }
    return sendSmtp(
      {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587),
        secure: env.SMTP_SECURE === true,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.SMTP_FROM,
        allowInsecure: env.SMTP_ALLOW_INSECURE === true,
      },
      options,
    );
  }

  if (transport === 'resend' && resend !== null && env.NODE_ENV !== 'test') {
    if (!env.RESEND_FROM) {
      return { ok: false, error: 'RESEND_FROM is required when Resend is configured' };
    }
    const { data, error } = await resend.emails.send({
      from: env.RESEND_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    if (error) return { ok: false, error: error.message ?? 'send failed' };
    return { ok: true, id: data?.id ?? 'unknown' };
  }

  return sendViaOutbox(options);
}

export function renderMagicLinkEmail(opts: { url: string; email: string; siteName: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Sign in to ${opts.siteName}`;
  const text = [
    `Hello,`,
    ``,
    `Click the link below to sign in to ${opts.siteName}. The link is good for 15 minutes.`,
    ``,
    opts.url,
    ``,
    `If you didn't request this, you can safely ignore this email.`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#faf6ee;color:#2b2722;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:48px auto;padding:32px;background:#fffdf9;border:1px solid #ece2cf;border-radius:16px;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#2f5142;font-family:Georgia,'Times New Roman',serif;">Sign in to ${opts.siteName}</h1>
      <p style="margin:0 0 20px;line-height:1.55;color:#756c5e;">
        Tap the button below to sign in. This link is good for 15 minutes and only works once.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${opts.url}" style="display:inline-block;padding:14px 22px;background:#5b8a72;color:#fffdf9;text-decoration:none;border-radius:999px;font-weight:600;">
          Sign in
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#a99e8c;">Or paste this URL into your browser:</p>
      <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#756c5e;">${opts.url}</p>
      <p style="margin:0;font-size:12px;color:#a99e8c;">
        Didn't request this? You can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;
  return { subject, html, text };
}

export function renderOtpEmail(opts: { code: string; email: string; siteName: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Your ${opts.siteName} sign-in code`;
  const text = [
    `Hello,`,
    ``,
    `Your ${opts.siteName} sign-in code is:`,
    ``,
    opts.code,
    ``,
    `It is good for 15 minutes and only works once.`,
    `If you didn't request this, you can safely ignore it.`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#faf6ee;color:#2b2722;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:48px auto;padding:32px;background:#fffdf9;border:1px solid #ece2cf;border-radius:16px;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#2f5142;font-family:Georgia,'Times New Roman',serif;">Your sign-in code</h1>
      <p style="margin:0 0 20px;line-height:1.55;color:#756c5e;">
        Enter this code in ${opts.siteName}. It is good for 15 minutes and only works once.
      </p>
      <p style="margin:0 0 24px;font-size:32px;letter-spacing:0.2em;font-weight:700;color:#2f5142;">${opts.code}</p>
      <p style="margin:0;font-size:12px;color:#a99e8c;">
        Didn't request this? You can safely ignore this message.
      </p>
    </div>
  </body>
</html>`;
  return { subject, html, text };
}
