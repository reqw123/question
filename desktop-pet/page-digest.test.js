import { describe, it, expect, vi } from 'vitest';
import { fetchPageText, PageDigestError } from './page-digest.js';

describe('fetchPageText', () => {
  it('strips HTML tags and returns plain text when the fetch succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body><script>evil()</script><h1>標題</h1><p>內文 A</p></body></html>',
    });

    const result = await fetchPageText({ url: 'https://example.com/article', fetchImpl });

    expect(result).toContain('標題');
    expect(result).toContain('內文 A');
    expect(result).not.toContain('evil()');
    expect(result).not.toContain('<');
  });

  it('rejects a non-URL string without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchPageText({ url: '這不是網址', fetchImpl })
    ).rejects.toMatchObject({ name: 'PageDigestError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a non-OK response as a fetch error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    await expect(
      fetchPageText({ url: 'https://example.com/missing', fetchImpl })
    ).rejects.toMatchObject({ name: 'PageDigestError', code: 'FETCH_ERROR' });
  });

  it('classifies a network-layer failure as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(
      fetchPageText({ url: 'https://example.com/', fetchImpl })
    ).rejects.toMatchObject({ name: 'PageDigestError', code: 'NETWORK_ERROR' });
  });

  it('truncates very long page text to a bounded length', async () => {
    const longText = 'a'.repeat(10000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<p>${longText}</p>`,
    });

    const result = await fetchPageText({ url: 'https://example.com/long', fetchImpl });

    expect(result.length).toBeLessThanOrEqual(4000);
  });
});
