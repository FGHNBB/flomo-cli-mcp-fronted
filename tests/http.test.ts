import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT } from '../src/core/contract';
import { buildHeaders, buildSignedParams, buildUrl, serializeParams } from '../src/core/http';
import { md5 } from '../src/core/sign';

const AUTH = {
  accessToken: 'token-123',
  deviceId: 'device-abc',
  platform: 'web',
  deviceModel: 'Windows',
  savedAt: '2026-09-24T00:00:00.000Z',
};

describe('buildUrl', () => {
  it('拼接基址与相对路径', () => {
    expect(buildUrl('https://flomoapp.com/api/v1', '/memo/')).toBe('https://flomoapp.com/api/v1/memo/');
    expect(buildUrl('https://flomoapp.com/api/v1', 'memo/abc')).toBe('https://flomoapp.com/api/v1/memo/abc');
  });

  it('已是绝对地址时原样返回', () => {
    expect(buildUrl('https://flomoapp.com/api/v1', 'https://flomoapp.com/api/v2/memo')).toBe(
      'https://flomoapp.com/api/v2/memo',
    );
  });
});

describe('serializeParams', () => {
  it('数组展开为 key[]，跳过空值', () => {
    expect(serializeParams({ a: 1, b: ['x', 'y'], c: undefined, d: null })).toBe(
      'a=1&b[]=x&b[]=y',
    );
  });

  it('对值做 URL 编码', () => {
    expect(serializeParams({ tag: '读书/小说' })).toBe('tag=%E8%AF%BB%E4%B9%A6%2F%E5%B0%8F%E8%AF%B4');
  });
});

describe('buildSignedParams', () => {
  const now = new Date('2026-09-24T00:00:00.000Z');
  const timestamp = Math.floor(now.getTime() / 1000);

  it('补齐公共参数并计算 sign', () => {
    const params = buildSignedParams({ content: 'hi' }, DEFAULT_CONTRACT, now);
    expect(params).toMatchObject({
      content: 'hi',
      api_key: DEFAULT_CONTRACT.apiKey,
      app_version: DEFAULT_CONTRACT.appVersion,
      platform: DEFAULT_CONTRACT.platform,
      webp: '1',
      timestamp,
    });

    const expectedSource = [
      `api_key=${DEFAULT_CONTRACT.apiKey}`,
      `app_version=${DEFAULT_CONTRACT.appVersion}`,
      'content=hi',
      `platform=${DEFAULT_CONTRACT.platform}`,
      `timestamp=${timestamp}`,
      'webp=1',
    ].join('&');
    expect(params.sign).toBe(md5(expectedSource + DEFAULT_CONTRACT.signSalt));
  });

  it('忽略调用方传入的旧 sign', () => {
    const withOldSign = buildSignedParams({ content: 'hi', sign: 'stale' }, DEFAULT_CONTRACT, now);
    const without = buildSignedParams({ content: 'hi' }, DEFAULT_CONTRACT, now);
    expect(withOldSign.sign).toBe(without.sign);
  });
});

describe('buildHeaders', () => {
  it('带上 Bearer 与设备头', () => {
    expect(buildHeaders(AUTH)).toMatchObject({
      Authorization: 'Bearer token-123',
      platform: 'web',
      'device-model': 'Windows',
      'device-id': 'device-abc',
    });
    expect(buildHeaders(AUTH)['Content-Type']).toBeUndefined();
    expect(buildHeaders(AUTH, { json: true })['Content-Type']).toBe('application/json');
  });
});
