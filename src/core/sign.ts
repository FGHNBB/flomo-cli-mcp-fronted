import { createHash } from 'node:crypto';

export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** 与 flomo 网页端 `_ksort` 一致：按 key 升序重排。 */
export function ksort(params: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) sorted[key] = params[key];
  return sorted;
}

/**
 * 忠实移植 flomo 网页端 `_getSign` 的拼接规则：
 * - 跳过 undefined / null / 空串 / false / NaN（0 会被保留）
 * - 数组按元素字符串升序排序后展开成 `key[]=value&`
 * - 其余值按 `key=value&` 拼接，末尾去掉多余的 `&`
 */
export function buildSignSource(params: Record<string, unknown>): string {
  const sorted = ksort(params);
  let source = '';

  for (const key of Object.keys(sorted)) {
    const value = sorted[key];
    if (value === undefined || value === null) continue;
    if (!(value || value === 0)) continue;

    if (Array.isArray(value)) {
      const items = [...value].sort((a, b) =>
        a && b ? String(a).localeCompare(String(b)) : 0,
      );
      for (const item of items) source += `${key}[]=${String(item)}&`;
    } else {
      source += `${key}=${String(value)}&`;
    }
  }

  return source.substring(0, source.length - 1);
}

export function calculateSign(params: Record<string, unknown>, salt: string): string {
  return md5(`${buildSignSource(params)}${salt}`);
}
