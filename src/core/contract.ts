import fs from 'node:fs';
import path from 'node:path';
import { FlomoError, errorMessage } from './errors.js';
import { ensureDir, restrictAccess } from './paths.js';

export interface FlomoContract {
  /** 读接口基址，例如 https://flomoapp.com/api/v1 */
  baseV1: string;
  /** 写接口基址（生产环境走 v2），例如 https://flomoapp.com/api/v2 */
  baseV2: string;
  apiKey: string;
  signSalt: string;
  appVersion: string;
  platform: string;
  fetchedAt: string;
  sourceUrl: string;
}

export const CONTRACT_PAGE_URL = 'https://v.flomoapp.com/mine';
export const CONTRACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

/**
 * 请求使用的 UA。
 * 这是**协议常量**：用来模拟 flomo 网页客户端，与宿主机装的是什么系统无关，
 * 因此不随 process.platform 变化（换 UA 可能触发风控，也会改变服务端看到的行为）。
 * 需要时可用环境变量 FLOMO_USER_AGENT 覆盖。
 */
export function resolveUserAgent(): string {
  return process.env.FLOMO_USER_AGENT?.trim() || USER_AGENT;
}

/** 线上 bundle 抓取失败时的兜底值，来自 2026-09 的 flomo-web 5.26.x。 */
export const DEFAULT_CONTRACT: FlomoContract = {
  baseV1: 'https://flomoapp.com/api/v1',
  baseV2: 'https://flomoapp.com/api/v2',
  apiKey: 'flomo_web',
  signSalt: 'dbbc3dd73364b4084c3a69346e0ce2b2',
  appVersion: '4.0',
  platform: 'web',
  fetchedAt: '1970-01-01T00:00:00.000Z',
  sourceUrl: 'built-in-defaults',
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * bundle 里 `app_version` 出现多次（`"2.0"` 与三元表达式的兜底值 `"4.0"`），
 * 而网页端非 Electron 分支实际发送的是三元表达式里的那个值，因此优先取分支值。
 */
export function extractAppVersion(bundle: string): string {
  const branch = bundle.match(/:\s*[A-Za-z_$][\w$]*\.app_version=["']([0-9.]+)["']/)?.[1];
  if (branch) return branch;
  const all = Array.from(bundle.matchAll(/app_version=["']([0-9.]+)["']/g)).map((m) => m[1] ?? '');
  return all.at(-1) ?? DEFAULT_CONTRACT.appVersion;
}

/** 从 flomo 首页 HTML 中定位前端 index bundle。 */
export function pickIndexBundleUrl(html: string, pageUrl = CONTRACT_PAGE_URL): string {
  const srcs = Array.from(html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)).map((m) => m[1] ?? '');
  const resolved = srcs
    .map((src) => {
      try {
        return new URL(src, pageUrl).toString();
      } catch {
        return '';
      }
    })
    .filter((url) => url.length > 0);

  const preferred =
    resolved.find((url) => /flomo-web\/js\/index\.[0-9a-f]+\.js$/i.test(url)) ??
    resolved.find((url) => /flomo-web\/js\/index[^/]*\.js$/i.test(url));

  if (!preferred) {
    throw new FlomoError('CONTRACT', '无法从 flomo 页面 HTML 中定位前端 bundle 地址');
  }
  return preferred;
}

/** 从 bundle 中提取 api_key、签名盐值与接口基址。 */
export function extractContract(
  bundle: string,
  sourceUrl: string,
  fetchedAt = new Date().toISOString(),
): FlomoContract {
  const salt =
    bundle.match(/_getSign\([^)]*\)\{[\s\S]{0,2000}?["']([0-9a-f]{32})["']/)?.[1] ??
    bundle.match(/\+["']([0-9a-f]{32})["']\)/)?.[1];

  if (!salt) {
    throw new FlomoError('CONTRACT', '无法从线上 bundle 提取签名盐值，flomo 前端可能已改版');
  }

  const apiKey = bundle.match(/api_key=["']([^"']+)["']/)?.[1] ?? DEFAULT_CONTRACT.apiKey;
  const appVersion = extractAppVersion(bundle);
  const bases = Array.from(
    new Set(Array.from(bundle.matchAll(/https:\/\/flomoapp\.com\/api\/(v[12])/g)).map((m) => m[0])),
  );

  return {
    baseV1: bases.find((base) => base.endsWith('/v1')) ?? DEFAULT_CONTRACT.baseV1,
    baseV2: bases.find((base) => base.endsWith('/v2')) ?? DEFAULT_CONTRACT.baseV2,
    apiKey,
    signSalt: salt,
    appVersion,
    platform: DEFAULT_CONTRACT.platform,
    fetchedAt,
    sourceUrl,
  };
}

export async function fetchContract(
  fetchImpl: FetchLike = fetch,
  pageUrl = CONTRACT_PAGE_URL,
): Promise<FlomoContract> {
  let html: string;
  try {
    const response = await fetchImpl(pageUrl, { headers: { 'user-agent': resolveUserAgent() } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    throw new FlomoError('NETWORK', `获取 flomo 页面失败：${errorMessage(error)}`, { cause: error });
  }

  const bundleUrl = pickIndexBundleUrl(html, pageUrl);

  let bundle: string;
  try {
    const response = await fetchImpl(bundleUrl, { headers: { 'user-agent': resolveUserAgent() } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bundle = await response.text();
  } catch (error) {
    throw new FlomoError('NETWORK', `获取 flomo 前端 bundle 失败：${errorMessage(error)}`, { cause: error });
  }

  return extractContract(bundle, bundleUrl);
}

export function contractFile(dataDir: string): string {
  return path.join(dataDir, 'contract.json');
}

export function readCachedContract(dataDir: string): FlomoContract | null {
  try {
    const raw = fs.readFileSync(contractFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FlomoContract>;
    if (
      typeof parsed.baseV1 === 'string' &&
      typeof parsed.baseV2 === 'string' &&
      typeof parsed.apiKey === 'string' &&
      typeof parsed.signSalt === 'string' &&
      typeof parsed.appVersion === 'string' &&
      typeof parsed.platform === 'string' &&
      typeof parsed.fetchedAt === 'string'
    ) {
      return {
        baseV1: parsed.baseV1,
        baseV2: parsed.baseV2,
        apiKey: parsed.apiKey,
        signSalt: parsed.signSalt,
        appVersion: parsed.appVersion,
        platform: parsed.platform,
        fetchedAt: parsed.fetchedAt,
        sourceUrl: parsed.sourceUrl ?? 'cache',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveContract(dataDir: string, contract: FlomoContract): string[] {
  ensureDir(dataDir);
  const file = contractFile(dataDir);
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return restrictAccess(file);
}

export interface ContractState {
  contract: FlomoContract;
  source: 'cache' | 'fetched' | 'default';
  warnings: string[];
}

export interface LoadContractOptions {
  refresh?: boolean;
  maxAgeMs?: number;
  fetchImpl?: FetchLike;
}

export async function loadContract(
  dataDir: string,
  options: LoadContractOptions = {},
): Promise<ContractState> {
  const maxAgeMs = options.maxAgeMs ?? CONTRACT_MAX_AGE_MS;
  const cached = readCachedContract(dataDir);
  const fresh = cached ? Date.now() - Date.parse(cached.fetchedAt) < maxAgeMs : false;

  if (!options.refresh && cached && fresh) {
    return { contract: cached, source: 'cache', warnings: [] };
  }

  try {
    const contract = await fetchContract(options.fetchImpl ?? fetch);
    // 配置目录可能不可写（容器 / 只读挂载）：缓存失败只告警，不影响本次使用抓到的契约
    let warnings: string[];
    try {
      warnings = saveContract(dataDir, contract);
    } catch (error) {
      warnings = [`契约缓存写入失败（不影响本次使用）：${errorMessage(error)}`];
    }
    return { contract, source: 'fetched', warnings };
  } catch (error) {
    const warning = `契约提取失败：${errorMessage(error)}`;
    if (cached) return { contract: cached, source: 'cache', warnings: [warning] };
    return { contract: DEFAULT_CONTRACT, source: 'default', warnings: [warning] };
  }
}
