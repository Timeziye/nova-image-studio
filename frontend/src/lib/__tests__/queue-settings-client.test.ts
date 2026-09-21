import { afterEach, describe, expect, it, vi } from 'vitest';
import { NovaTaskError, updateNovaPerKeyConcurrency } from '@/lib/ccode-task-client';

afterEach(() => vi.unstubAllGlobals());

describe('global per-key concurrency settings', () => {
  it('sends the requested value with an admin password to the server', async () => {
    const status = { perKeyConcurrencyMinimum: 4, perKeyConcurrencyLimit: 10, configuredPerKeyConcurrency: 4 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => status });
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateNovaPerKeyConcurrency(4, 'test-admin-password')).resolves.toEqual(status);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/nova/admin/per-key-concurrency');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-admin-password' });
    expect(JSON.parse(String(init.body))).toEqual({ value: 4 });
  });

  it('surfaces an unauthorized save without changing the displayed value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: '管理员口令错误', code: 'ADMIN_UNAUTHORIZED' }),
    }));

    await expect(updateNovaPerKeyConcurrency(4, 'wrong-password'))
      .rejects.toMatchObject({ name: NovaTaskError.name, statusCode: 401, code: 'ADMIN_UNAUTHORIZED' });
  });
});
