import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlomoClient } from '../src/core/client';
import { DEFAULT_CONTRACT, type FetchLike } from '../src/core/contract';

const AUTH = {
  accessToken: 'token-123',
  deviceId: 'device-abc',
  platform: 'web',
  deviceModel: 'Windows',
  savedAt: '2026-09-24T00:00:00.000Z',
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeResponse(body: string, status = 200, contentType = 'application/json'): Response {
  return {
    ok: status < 400,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => body,
  } as unknown as Response;
}

function clientWith(
  handler: (captured: Captured) => { status?: number; contentType?: string; body: string },
): { client: FlomoClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const captured: Captured = { url, init: init ?? {} };
    calls.push(captured);
    const result = handler(captured);
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (result.contentType ?? 'application/json') : null) },
      text: async () => result.body,
    } as unknown as Response;
  };
  const client = new FlomoClient({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-client-')),
    auth: AUTH,
    contract: DEFAULT_CONTRACT,
    fetchImpl,
    autoRefreshContract: false,
  });
  return { client, calls };
}

describe('FlomoClient 请求构造', () => {
  it('GET 把签名参数放进查询串', async () => {
    const { client, calls } = clientWith(() => ({ body: JSON.stringify({ code: 0, data: [] }) }));
    await client.call('GET', '/memo/', { params: { limit: 3 } });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/memo/');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('api_key')).toBe(DEFAULT_CONTRACT.apiKey);
    expect(url.searchParams.get('sign')).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  it('POST 把签名参数放进 JSON body，且查询串为空', async () => {
    const { client, calls } = clientWith(() => ({ body: JSON.stringify({ code: 0, data: { slug: 's1' } }) }));
    await client.call('POST', '/memo', { baseUrl: DEFAULT_CONTRACT.baseV2, body: { content: 'hello' } });

    expect(new URL(calls[0]!.url).pathname).toBe('/api/v2/memo');
    expect(new URL(calls[0]!.url).search).toBe('');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.content).toBe('hello');
    expect(body.sign).toMatch(/^[0-9a-f]{32}$/);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('useBody 让 DELETE 也走 body', async () => {
    const { client, calls } = clientWith(() => ({ body: JSON.stringify({ code: 0, data: null }) }));
    await client.call('DELETE', '/memo/batch-delete', {
      useBody: true,
      body: { memo_slugs: ['a', 'b'] },
    });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.memo_slugs).toEqual(['a', 'b']);
  });
});

describe('FlomoClient 错误映射', () => {
  it('code 非 0 抛 API 错误', async () => {
    const { client } = clientWith(() => ({ body: JSON.stringify({ code: 11, message: '参数缺失' }) }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({
      kind: 'API',
      message: '参数缺失',
      exitCode: 1,
    });
  });

  it('业务码 -10（请先登录）映射为鉴权错误', async () => {
    const { client } = clientWith(() => ({ body: JSON.stringify({ code: -10, message: '请先登录' }) }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({
      kind: 'AUTH',
      exitCode: 3,
      details: { code: -10 },
    });
  });

  it('业务码 -100（sign 错误）映射为契约错误（退出码 5）', async () => {
    const { client } = clientWith(() => ({ body: JSON.stringify({ code: -100, message: 'sign 错误' }) }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({
      kind: 'CONTRACT',
      exitCode: 5,
      details: { code: -100 },
    });
  });

  it('401 抛鉴权错误（退出码 3）', async () => {
    const { client } = clientWith(() => ({ status: 401, body: '{}' }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'AUTH', exitCode: 3 });
  });

  it('返回 HTML 时抛解析错误', async () => {
    const { client } = clientWith(() => ({ contentType: 'text/html', body: '<html></html>' }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('返回非 JSON 时抛解析错误', async () => {
    const { client } = clientWith(() => ({ body: 'not-json' }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('空响应体视为成功（兼容 204 / 无内容返回）', async () => {
    const { client } = clientWith(() => ({ status: 204, body: '' }));
    await expect(client.call('DELETE', '/memo/abc')).resolves.toBeNull();
  });

  it('空响应体 + 5xx 视为 API 错误', async () => {
    const { client } = clientWith(() => ({ status: 500, body: '   ' }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'API' });
  });

  it('网络异常抛网络错误（退出码 4）', async () => {
    const client = new FlomoClient({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-client-net-')),
      auth: AUTH,
      contract: DEFAULT_CONTRACT,
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      autoRefreshContract: false,
    });
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'NETWORK', exitCode: 4 });
  });

  it('HTTP 500 抛 API 错误', async () => {
    const { client } = clientWith(() => ({ status: 500, body: JSON.stringify({ code: 0 }) }));
    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'API' });
  });
});

describe('契约自愈', () => {
  const PAGE_HTML = '<script src="https://resource.test/flomo-web/js/index.abc123.js"></script>';
  const BUNDLE = [
    'static _getSign(e){return t=t.substring(0,t.length-1),',
    'm(t+"dbbc3dd73364b4084c3a69346e0ce2b2")}',
    'static prepareParams(){i.api_key="flomo_web",i.app_version="2.0";',
    'x?y():i.app_version="4.0"}',
    'const a="https://flomoapp.com/api/v1",b="https://flomoapp.com/api/v2"',
  ].join('');

  function contractFetch(apiResponse: () => Response, counter: { calls: number }): FetchLike {
    return async (url: string) => {
      if (url.includes('v.flomoapp.com/mine')) return fakeResponse(PAGE_HTML);
      if (url.includes('index.abc123.js')) return fakeResponse(BUNDLE);
      counter.calls += 1;
      return apiResponse();
    };
  }

  function makeClient(fetchImpl: FetchLike): FlomoClient {
    return new FlomoClient({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-client-heal-')),
      auth: AUTH,
      contract: DEFAULT_CONTRACT,
      fetchImpl,
    });
  }

  it('遇到 sign 错误时重拉契约并重试一次，随后成功', async () => {
    const counter = { calls: 0 };
    const client = makeClient(
      contractFetch(
        () =>
          counter.calls === 1
            ? fakeResponse(JSON.stringify({ code: -100, message: 'sign 错误' }))
            : fakeResponse(JSON.stringify({ code: 0, data: { slug: 'healed' } })),
        counter,
      ),
    );

    await expect(client.call('GET', '/memo/')).resolves.toEqual({ slug: 'healed' });
    expect(counter.calls).toBe(2);
    expect(client.currentContract.signSalt).toBe(DEFAULT_CONTRACT.signSalt);
    expect(client.currentContract.appVersion).toBe('4.0');
  });

  it('重试后仍失败则抛契约错误，且只重试一次', async () => {
    const counter = { calls: 0 };
    const client = makeClient(
      contractFetch(() => fakeResponse(JSON.stringify({ code: -100, message: 'sign 错误' })), counter),
    );

    await expect(client.call('GET', '/memo/')).rejects.toMatchObject({ kind: 'CONTRACT', exitCode: 5 });
    expect(counter.calls).toBe(2);
  });
});
