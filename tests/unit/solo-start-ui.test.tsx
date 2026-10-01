/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoloStart } from '@/app/solo/start/SoloStart';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/app/solo/start/navigation', () => ({ openSoloHome: navigate }));
const fetcher = vi.fn<typeof fetch>();
const tokenA = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
const tokenB = `${'c'.repeat(64)}.${'d'.repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(ok: boolean, reason = 'used') {
  return { ok, json: async () => ({ reason }) } as Response;
}
function showHash(token: string) {
  act(() => {
    window.history.pushState(null, '', `/solo/start#${token}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  fetcher.mockReset();
  navigate.mockReset();
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState(null, '', '/solo/start');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('solo launcher same-document recovery', () => {
  it('hard-navigates after session creation rather than reusing a cached server render', async () => {
    const navigation = await vi.importActual<typeof import('@/app/solo/start/navigation')>(
      '@/app/solo/start/navigation',
    );
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { replace } });
    try {
      navigation.openSoloHome();
      expect(replace).toHaveBeenCalledWith('/');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('can recover with a fresh hash after an earlier request has failed', async () => {
    fetcher.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    render(<SoloStart />);
    showHash(tokenA);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('expired');
    showHash(tokenB);
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });
  it('consumes a later signed hash from the plain recovery page, clearing it before POST', async () => {
    const result = deferred<Response>();
    fetcher.mockImplementation(() => {
      expect(window.location.hash).toBe('');
      return result.promise;
    });
    render(<SoloStart />);
    expect(screen.getByRole('status')).toHaveTextContent('Open Examify from its launcher');
    expect(fetcher).not.toHaveBeenCalled();
    showHash(tokenA);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/solo/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ token: tokenA }),
      }),
    );
    await act(async () => {
      result.resolve(response(true));
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate an initial request under StrictMode or repeated in-flight hashes', async () => {
    const result = deferred<Response>();
    fetcher.mockReturnValue(result.promise);
    window.history.replaceState(null, '', `/solo/start#${tokenA}`);
    render(
      <StrictMode>
        <SoloStart />
      </StrictMode>,
    );
    showHash(tokenA);
    showHash(tokenA);
    expect(window.location.hash).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.resolve(response(true));
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('accepts a new hash while a request is pending and ignores the older success', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetcher.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SoloStart />);
    showHash(tokenA);
    showHash(tokenB);
    await act(async () => {
      first.resolve(response(true));
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Opening your learning space');
    await act(async () => {
      second.resolve(response(false, 'existing_data'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('already contains household data');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('ignores stale JSON completion after a newer token arrives', async () => {
    const body = deferred<{ reason: string }>();
    const second = deferred<Response>();
    fetcher
      .mockResolvedValueOnce({ ok: false, json: () => body.promise } as Response)
      .mockReturnValueOnce(second.promise);
    render(<SoloStart />);
    showHash(tokenA);
    await act(async () => {});
    showHash(tokenB);
    await act(async () => {
      body.resolve({ reason: 'existing_data' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Opening your learning space');
    await act(async () => {
      second.resolve(response(true));
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('recovers after a failed token with a different token and ignores old rejection', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetcher.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SoloStart />);
    showHash(tokenA);
    showHash(tokenB);
    await act(async () => {
      first.reject(new Error('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Opening your learning space');
    await act(async () => {
      second.resolve(response(false));
    });
    expect(screen.getByRole('status')).toHaveTextContent('expired');
    showHash(tokenB);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe('');
  });
  it('does not navigate after unmount and removes the hashchange listener', async () => {
    const result = deferred<Response>();
    fetcher.mockReturnValue(result.promise);
    const { unmount } = render(<SoloStart />);
    showHash(tokenA);
    unmount();
    showHash(tokenB);
    await act(async () => {
      result.resolve(response(true));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('clears a fragment before navigating an already active session without a bootstrap', () => {
    window.history.replaceState(null, '', `/solo/start#${tokenA}`);
    navigate.mockImplementation(() => {
      expect(window.location.hash).toBe('');
    });
    render(<SoloStart active />);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
