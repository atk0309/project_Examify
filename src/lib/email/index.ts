import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import { env, isTest } from '@/lib/env';

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

const resend = env.RESEND_API_KEY === 'test' ? null : new Resend(env.RESEND_API_KEY);

async function writeTestOutbox(payload: {
  to: string;
  subject: string;
  html: string;
}): Promise<string> {
  const outboxDir = path.join(process.cwd(), 'tests', '.tmp', 'outbox');
  await fs.mkdir(outboxDir, { recursive: true });
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(outboxDir, `${id}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ ...payload, sentAt: new Date().toISOString() }, null, 2),
  );
  return id;
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<SendResult> {
  if (resend === null || isTest) {
    const id = await writeTestOutbox({
      to: options.to,
      subject: options.subject,
      html: options.html,
    });
    return { ok: true, id };
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
