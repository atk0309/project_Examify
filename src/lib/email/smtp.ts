import 'server-only';
import net from 'node:net';
import tls from 'node:tls';

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Allow AUTH/DATA on a connection that never upgraded to TLS. */
  allowInsecure?: boolean;
};

type SmtpSocket = net.Socket | tls.TLSSocket;

const SMTP_TIMEOUT_MS = 15_000;

function crlf(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function buildMime(options: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}): string {
  const boundary = `examify=${Date.now().toString(36)}`;
  const text = options.text ?? options.html.replace(/<[^>]+>/g, ' ');
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${encodeSubject(options.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    crlf(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    crlf(options.html),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`;
}

function connect(config: SmtpConfig): Promise<SmtpSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () => {
          socket.off('error', onError);
          socket.off('timeout', onTimeout);
          settle(() => resolve(socket));
        })
      : net.connect({ host: config.host, port: config.port }, () => {
          socket.off('error', onError);
          socket.off('timeout', onTimeout);
          settle(() => resolve(socket));
        });
    const onTimeout = () => {
      socket.destroy();
      settle(() => reject(new Error('SMTP connect timeout')));
    };
    const onError = (error: Error) => {
      socket.destroy();
      settle(() => reject(error));
    };
    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
  });
}

function upgradeToTls(socket: SmtpSocket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const upgraded = tls.connect({ socket, servername: host }, () => {
      upgraded.off('error', onError);
      upgraded.off('timeout', onTimeout);
      settle(() => resolve(upgraded));
    });
    const onTimeout = () => {
      upgraded.destroy();
      settle(() => reject(new Error('SMTP TLS timeout')));
    };
    const onError = (error: Error) => {
      upgraded.destroy();
      settle(() => reject(error));
    };
    upgraded.setTimeout(SMTP_TIMEOUT_MS);
    upgraded.once('timeout', onTimeout);
    upgraded.once('error', onError);
  });
}

class SmtpSession {
  private buffer = '';
  constructor(private socket: SmtpSocket) {}

  setSocket(socket: SmtpSocket) {
    this.socket = socket;
    this.buffer = '';
  }

  async readReply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.length < 3) throw new Error('invalid SMTP reply');
      const code = Number(line.slice(0, 3));
      const sep = line[3];
      lines.push(line.slice(4));
      if (sep === ' ') return { code, lines };
      if (sep !== '-') throw new Error('invalid SMTP reply');
    }
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const tryConsume = () => {
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) return false;
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        resolve(raw.replace(/\r$/, ''));
        return true;
      };
      if (tryConsume()) return;
      const onData = (chunk: Buffer | string) => {
        this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (tryConsume()) {
          this.socket.off('data', onData);
          this.socket.off('error', onError);
          this.socket.off('timeout', onTimeout);
          this.socket.off('end', onEnd);
        }
      };
      const onError = (error: Error) => reject(error);
      const onTimeout = () => reject(new Error('SMTP timeout'));
      const onEnd = () => reject(new Error('SMTP connection closed'));
      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.once('timeout', onTimeout);
      this.socket.once('end', onEnd);
    });
  }

  write(data: string) {
    this.socket.write(data);
  }

  async command(
    line: string,
    expected: number | number[],
  ): Promise<{ code: number; lines: string[] }> {
    this.write(`${line}\r\n`);
    const reply = await this.readReply();
    const ok = Array.isArray(expected) ? expected.includes(reply.code) : reply.code === expected;
    if (!ok) {
      throw new Error(`SMTP ${reply.code}: ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  async startTls(host: string) {
    await this.command('STARTTLS', 220);
    const upgraded = await upgradeToTls(this.socket, host);
    this.setSocket(upgraded);
  }

  end() {
    this.socket.end();
    this.socket.destroy();
  }
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim();
}

/**
 * Sends one message through SMTP, upgrading with STARTTLS when advertised.
 * Plaintext delivery is refused unless `allowInsecure` is set. Connection,
 * protocol, and rejection errors are returned as failed results.
 */
export async function sendSmtp(
  config: SmtpConfig,
  message: { to: string; subject: string; html: string; text?: string },
): Promise<SendResult> {
  let session: SmtpSession | undefined;
  try {
    const socket = await connect(config);
    session = new SmtpSession(socket);
    const greeting = await session.readReply();
    if (greeting.code !== 220)
      throw new Error(`SMTP ${greeting.code}: ${greeting.lines.join(' ')}`);

    const ehlo = await session.command(`EHLO examify`, 250);
    const capabilities = ehlo.lines.map((line) => line.toUpperCase());
    let encrypted = config.secure;
    if (!encrypted && capabilities.some((line) => line.startsWith('STARTTLS'))) {
      await session.startTls(config.host);
      encrypted = true;
      await session.command(`EHLO examify`, 250);
    }
    if (!encrypted && !config.allowInsecure) {
      throw new Error(
        'Refusing unencrypted SMTP. Enable STARTTLS or SMTP_SECURE, or set SMTP_ALLOW_INSECURE=1.',
      );
    }

    if (config.user) {
      const pass = config.pass ?? '';
      const plain = Buffer.from(`\0${config.user}\0${pass}`).toString('base64');
      try {
        await session.command(`AUTH PLAIN ${plain}`, 235);
      } catch {
        await session.command('AUTH LOGIN', 334);
        await session.command(Buffer.from(config.user, 'utf8').toString('base64'), 334);
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), 235);
      }
    }

    await session.command(`MAIL FROM:<${extractEmail(config.from)}>`, 250);
    await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await session.command('DATA', 354);
    const payload = buildMime({
      from: config.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }).replace(/^\./gm, '..');
    session.write(`${payload}\r\n.\r\n`);
    const dataReply = await session.readReply();
    if (dataReply.code !== 250)
      throw new Error(`SMTP ${dataReply.code}: ${dataReply.lines.join(' ')}`);
    try {
      await session.command('QUIT', 221);
    } catch {
      // already sent
    }
    return { ok: true, id: `smtp-${Date.now()}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'smtp send failed' };
  } finally {
    session?.end();
  }
}
