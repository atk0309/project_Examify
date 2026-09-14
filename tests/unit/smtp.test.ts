import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sendSmtp } from '@/lib/email/smtp';

async function listen(
  handler: (socket: net.Socket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('sendSmtp', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) {
      await closers.pop()!();
    }
  });

  it('sends a message over AUTH PLAIN', async () => {
    const received: string[] = [];
    const server = await listen((socket) => {
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        received.push(text);
        for (const line of text.split('\r\n').filter(Boolean)) {
          if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) socket.write('235 2.7.0 OK\r\n');
          else if (line.startsWith('MAIL FROM')) socket.write('250 2.1.0 OK\r\n');
          else if (line.startsWith('RCPT TO')) socket.write('250 2.1.5 OK\r\n');
          else if (line === 'DATA') socket.write('354 go ahead\r\n');
          else if (line === '.') socket.write('250 2.0.0 queued\r\n');
          else if (line === 'QUIT') socket.write('221 bye\r\n');
        }
      });
    });
    closers.push(server.close);

    const result = await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        user: 'user',
        pass: 'pass',
        from: 'Examify <examify@example.com>',
      },
      { to: 'kid@example.com', subject: 'Hi', html: '<p>hello</p>', text: 'hello' },
    );
    expect(result.ok).toBe(true);
    expect(received.join('')).toContain('MAIL FROM:<examify@example.com>');
    expect(received.join('')).toContain('RCPT TO:<kid@example.com>');
  });

  it('returns SendResult failure when the server rejects', async () => {
    const server = await listen((socket) => {
      socket.write('554 no thanks\r\n');
    });
    closers.push(server.close);
    const result = await sendSmtp(
      {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        from: 'Examify <examify@example.com>',
      },
      { to: 'kid@example.com', subject: 'Hi', html: '<p>x</p>' },
    );
    expect(result.ok).toBe(false);
  });
});
