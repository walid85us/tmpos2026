// Phase 4.0 M4 — an API address is never a page: a page load of one renders a bounded "not found"
// straight from src/main.tsx, loading neither application nor the provider, sending no request
// and keeping the address as it is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ApiPathNotFound from './ApiPathNotFound';

const loaded = vi.hoisted((): string[] => []);
vi.mock('../../App.tsx', () => {
  loaded.push('tenant application');
  return { default: () => null };
});
vi.mock('./AdminConsoleApp', () => {
  loaded.push('administration console');
  return { default: () => null };
});
vi.mock('firebase/app', () => {
  loaded.push('firebase');
  return {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API address page', () => {
  it('is a bounded page with no console chrome, no link and no button', () => {
    render(<ApiPathNotFound />);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(main).toHaveTextContent('This address is not a page.');
    expect(document.title).toBe('Not found');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('Control Plane')).toBeNull();
  });

  it('is what a page load of an API address renders, before either application loads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no request expected'));
    window.history.replaceState(null, '', '/admin/v1/session');
    document.body.innerHTML = '<div id="root"></div>';
    await import('../../main');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(loaded).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/admin/v1/session');
  });
});
