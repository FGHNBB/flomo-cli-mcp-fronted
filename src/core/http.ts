import type { AuthData } from './auth.js';
import type { FlomoContract } from './contract.js';
import { resolveUserAgent } from './contract.js';
import { calculateSign } from './sign.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export { USER_AGENT, resolveUserAgent } from './contract.js';

export function buildUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase).toString();
}

/** 与 axios 默认序列化保持一致：数组展开为 `key[]=v1&key[]=v2`。 */
export function serializeParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    if (typeof value === 'object') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`);
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * 复刻网页端 `prepareParams`：补全固定参数后计算 sign。
 * 签名对象是 JSON 深拷贝（会丢掉 undefined），且不包含 sign 自身。
 */
export function buildSignedParams(
  params: Record<string, unknown>,
  contract: FlomoContract,
  now: Date = new Date(),
): Record<string, unknown> {
  const prepared: Record<string, unknown> = { ...params };
  delete prepared.sign;
  prepared.timestamp = Math.floor(now.getTime() / 1000);
  prepared.api_key = contract.apiKey;
  prepared.app_version = contract.appVersion;
  prepared.platform = contract.platform;
  prepared.webp = '1';

  const clone = JSON.parse(JSON.stringify(prepared)) as Record<string, unknown>;
  prepared.sign = calculateSign(clone, contract.signSalt);
  return prepared;
}

export function buildHeaders(auth: AuthData, options: { json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    platform: auth.platform || 'web',
    'device-model': auth.deviceModel,
    'device-id': auth.deviceId,
    'user-agent': resolveUserAgent(),
  };
  if (options.json) headers['Content-Type'] = 'application/json';
  return headers;
}
