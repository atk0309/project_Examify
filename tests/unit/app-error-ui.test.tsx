/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppError from '@/app/error';

afterEach(() => cleanup());

describe('app error boundary (src/app/error.tsx)', () => {
  it('shows calm copy without the error details, and "Try again" retries the page', () => {
    const retry = vi.fn();
    render(<AppError error={new Error('SQLITE_BUSY: internal detail')} retry={retry} />);

    const page = screen.getByTestId('app-error');
    expect(page).toHaveTextContent('Something went wrong');
    expect(page).toHaveTextContent('Anything already saved is kept.');
    expect(page).not.toHaveTextContent('SQLITE_BUSY');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers a full reload back to the start', () => {
    render(<AppError error={new Error('boom')} retry={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Back to the start' })).toHaveAttribute('href', '/');
  });
});
