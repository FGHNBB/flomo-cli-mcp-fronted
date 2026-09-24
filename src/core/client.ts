import path from 'node:path';
import { FlomoError, errorMessage } from './errors.js';
import { loadContract, type ContractState, type FetchLike, type FlomoContract } from './contract.js';
import { authFile, resolveAuth, saveAuth, type AuthData, type AuthSource } from './auth.js';
import { invalidAuthMessage, missingAuthMessage, shouldVerifyAuth } from './onboarding.js';
import {
  buildHeaders,
  buildSignedParams,
  buildUrl,
  serializeParams,
  type HttpMethod,
} from './http.js';
import { resolveDataDir } from './paths.js';
import { localTzOffset } from './tz.js';

export interface ApiPayload<T = unknown> {
  status: number;
  code: number;
  message: string;
  data: T;
  raw: unknown;
}

export interface CallOptions {
  params?: Record<string, unknown>;
  /** 写入类请求的业务字段，会与 params 合并后放进 JSON body */
  body?: Record<string, unknown>;
  /** 强制把参数放进 body（例如 DELETE /memo/batch-delete） */
  useBody?: boolean;
  baseUrl?: string;
}

/** 已构造好的请求（含签名参数），供实际发送或 dry-run 展示。 */
export interface RequestPlan {
  method: HttpMethod;
  url: string;
  bodyMode: boolean;
  /** 签名后的完整参数（含 timestamp / api_key / sign 等） */
  params: Record<string, unknown>;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiCaller {
  call<T = unknown>(method: HttpMethod, path: string, options?: CallOptions): Promise<T>;
  readonly baseV1: string;
  readonly baseV2: string;
  readonly timezone?: string;
}

/** flomo 业务码：-10 = 请先登录（凭据无效或已过期）。 */
export const AUTH_BUSINESS_CODES = new Set<number>([-10]);

/** flomo 业务码：-100 = sign 错误（通常是前端签名盐值已变更）。 */
export const CONTRACT_BUSINESS_CODES = new Set<number>([-100]);

export interface FlomoClientOptions {
  dataDir: string;
  contract: FlomoContract;
  auth: AuthData;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  timezone?: string;
  autoRefreshContract?: boolean;
  onWarn?: (message: string) => void;
}

function isDriftError(error: unknown): boolean {
  return error instanceof FlomoError && (error.kind === 'PARSE' || error.kind === 'CONTRACT');
}

export class FlomoClient implements ApiCaller {
  readonly dataDir: string;
  readonly auth: AuthData;
  readonly timezone: string | undefined;
  private contract: FlomoContract;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly autoRefreshContract: boolean;
  private readonly onWarn: (message: string) => void;

  constructor(options: FlomoClientOptions) {
    this.dataDir = options.dataDir;
    this.auth = options.auth;
    this.contract = options.contract;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.autoRefreshContract = options.autoRefreshContract ?? true;
    this.onWarn = options.onWarn ?? (() => {});
    this.timezone = options.timezone ?? process.env.FLOMO_TZ?.trim() ?? localTzOffset();
  }

  get baseV1(): string {
    return this.contract.baseV1;
  }

  get baseV2(): string {
    return this.contract.baseV2;
  }

  get currentContract(): FlomoContract {
    return this.contract;
  }

  async request<T = unknown>(
    method: HttpMethod,
    requestPath: string,
    options: CallOptions = {},
  ): Promise<ApiPayload<T>> {
    let refreshed = false;

    for (;;) {
      try {
        const payload = await this.perform<T>(method, requestPath, options);
        if (!refreshed && this.autoRefreshContract && CONTRACT_BUSINESS_CODES.has(payload.code)) {
          refreshed = true;
          this.onWarn('服务端返回 sign 错误，正在重新提取 flomo 契约参数后重试');
          await this.refreshContract();
          continue;
        }
        return payload;
      } catch (error) {
        if (!refreshed && this.autoRefreshContract && isDriftError(error)) {
          refreshed = true;
          this.onWarn(`${errorMessage(error)}；正在重新提取 flomo 契约参数后重试`);
          await this.refreshContract();
          continue;
        }
        throw error;
      }
    }
  }

  private async refreshContract(): Promise<void> {
    const state = await loadContract(this.dataDir, { refresh: true, fetchImpl: this.fetchImpl });
    this.contract = state.contract;
    for (const warning of state.warnings) this.onWarn(warning);
  }

  async call<T = unknown>(method: HttpMethod, requestPath: string, options: CallOptions = {}): Promise<T> {
    const payload = await this.request<T>(method, requestPath, options);

    if (payload.status === 401) {
      throw new FlomoError(
        'AUTH',
        '登录状态已失效（HTTP 401）：请重新获取 token（flomo setup 或 flomo auth login）',
      );
    }
    if (payload.status >= 400) {
      throw new FlomoError(
        'API',
        `HTTP ${payload.status}${payload.message ? `：${payload.message}` : ''}`,
        { details: { status: payload.status } },
      );
    }
    if (payload.code !== 0) {
      if (AUTH_BUSINESS_CODES.has(payload.code)) {
        throw new FlomoError(
          'AUTH',
          `${payload.message || '登录状态无效'}（业务码 ${payload.code}）：请重新获取 token（flomo setup 或 flomo auth login）`,
          { details: { code: payload.code } },
        );
      }
      if (CONTRACT_BUSINESS_CODES.has(payload.code)) {
        throw new FlomoError(
          'CONTRACT',
          `${payload.message || 'sign 校验失败'}（业务码 ${payload.code}）：缓存的签名参数已失效，请执行 flomo doctor --refresh-contract`,
          { details: { code: payload.code } },
        );
      }
      throw new FlomoError('API', payload.message || `接口返回业务错误 code=${payload.code}`, {
        details: { code: payload.code },
      });
    }
    return payload.data;
  }

  /** 构造请求但不发送，用于 --dry-run 展示内部请求计划。 */
  plan(method: HttpMethod, requestPath: string, options: CallOptions = {}): RequestPlan {
    return this.buildPlan(method, requestPath, options);
  }

  private buildPlan(method: HttpMethod, requestPath: string, options: CallOptions): RequestPlan {
    const upperMethod = method.toUpperCase() as HttpMethod;
    const bodyMode =
      options.useBody ?? (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH');
    const baseUrl = options.baseUrl ?? this.contract.baseV1;
    const base = buildUrl(baseUrl, requestPath);

    const params: Record<string, unknown> = { ...(options.params ?? {}) };
    if (bodyMode) Object.assign(params, options.body ?? {});
    const signed = buildSignedParams(params, this.contract);
    const headers = buildHeaders(this.auth, { json: bodyMode });

    if (bodyMode) {
      const body = JSON.stringify(signed);
      return { method: upperMethod, url: base, bodyMode, params: signed, headers, body };
    }

    const query = serializeParams(signed);
    const url = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
    return { method: upperMethod, url, bodyMode, params: signed, headers };
  }

  private async perform<T>(
    method: HttpMethod,
    requestPath: string,
    options: CallOptions,
  ): Promise<ApiPayload<T>> {
    const plan = this.buildPlan(method, requestPath, options);
    const init: RequestInit = {
      method: plan.method,
      headers: plan.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(plan.body !== undefined ? { body: plan.body } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(plan.url, init);
    } catch (error) {
      throw new FlomoError(
        'NETWORK',
        `请求 ${plan.method} ${requestPath} 失败：${errorMessage(error)}`,
        { cause: error },
      );
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';

    if (response.status === 401) {
      throw new FlomoError(
        'AUTH',
        '登录状态已失效（HTTP 401）：请重新获取 token（flomo setup 或 flomo auth login）',
      );
    }
    // 部分接口（如批量删除）成功时返回空 body / 204，不能当成解析失败
    if (text.trim() === '') {
      if (response.status >= 400) {
        throw new FlomoError('API', `HTTP ${response.status}（响应体为空）`, {
          details: { status: response.status },
        });
      }
      return { status: response.status, code: 0, message: '', data: null as T, raw: null };
    }
    if (contentType.includes('html') || /^\s*</.test(text)) {
      throw new FlomoError(
        'PARSE',
        `接口返回 HTML 而非 JSON（HTTP ${response.status}），通常是登录失效或触发风控`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new FlomoError('PARSE', `接口返回无法解析：${text.slice(0, 200)}`, { cause: error });
    }

    const record = (parsed ?? {}) as Record<string, unknown>;
    const rawCode = record.code;
    const numericCode =
      typeof rawCode === 'number'
        ? rawCode
        : typeof rawCode === 'string' && rawCode.trim() !== ''
          ? Number(rawCode)
          : 0;

    return {
      status: response.status,
      code: Number.isNaN(numericCode) ? 0 : numericCode,
      message: typeof record.message === 'string' ? record.message : '',
      data: (record.data ?? null) as T,
      raw: parsed,
    };
  }
}

export interface CreateClientResult {
  client: FlomoClient;
  auth: AuthData;
  /** 凭据来源：file / env:FLOMO_AUTH_JSON / env:FLOMO_AUTH_FILE / env:FLOMO_TOKEN */
  authSource: AuthSource;
  dataDir: string;
  contractState: ContractState;
  warnings: string[];
}

export interface CreateClientOptions {
  dataDir?: string | undefined;
  refreshContract?: boolean;
  fetchImpl?: FetchLike;
  onWarn?: (message: string) => void;
  timeoutMs?: number;
  /** 是否允许联网校验鉴权文件（--dry-run 这类只应看计划的场景传 false） */
  verifyAuth?: boolean;
}

export interface EnsureAuthOptions {
  dataDir: string;
  contract: FlomoContract;
  fetchImpl?: FetchLike;
  verify?: boolean;
  onWarn?: (message: string) => void;
}

export interface EnsureAuthResult {
  auth: AuthData;
  /** 本次是否真的联网校验过 */
  verified: boolean;
  warnings: string[];
  /** 凭据来源：文件 or 环境变量 */
  source: AuthSource;
}

export interface VerifyAuthResult {
  userId?: string | number;
  nickname?: string;
}

/** 用 /user/me 验证鉴权文件是否可用；失效时抛出带修复指引的 AUTH 错误。 */
export async function verifyAuthToken(options: {
  dataDir: string;
  auth: AuthData;
  contract: FlomoContract;
  fetchImpl?: FetchLike;
  onWarn?: (message: string) => void;
}): Promise<VerifyAuthResult> {
  const client = new FlomoClient({
    dataDir: options.dataDir,
    auth: options.auth,
    contract: options.contract,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  let me: Record<string, unknown>;
  try {
    me = await client.call<Record<string, unknown>>('GET', '/user/me');
  } catch (error) {
    if (error instanceof FlomoError && error.kind === 'AUTH') {
      throw new FlomoError('AUTH', invalidAuthMessage(error.message), { cause: error });
    }
    throw error;
  }

  const info: VerifyAuthResult = {};
  const id = me.id ?? me.user_id;
  if (typeof id === 'string' || typeof id === 'number') info.userId = id;
  const name = me.name ?? me.nickname;
  if (typeof name === 'string' && name.length > 0) info.nickname = name;
  return info;
}

/**
 * 首次启动引导：
 * - 配置目录里没有 auth.json → 报错并给出取 token 的指引
 * - 有 auth.json 但从未校验 / 校验过期 → 联网测试可用性，并把校验时间写回
 */
export async function ensureAuthReady(options: EnsureAuthOptions): Promise<EnsureAuthResult> {
  const resolved = resolveAuth(options.dataDir);
  if (!resolved) {
    throw new FlomoError('AUTH', missingAuthMessage(options.dataDir, authFile(options.dataDir)));
  }

  const { auth } = resolved;

  // 环境变量注入的凭据是只读的：没有地方缓存校验结果，因此不做预检。
  // 真正发请求时若已失效会照常返回 AUTH 错误；需要显式校验可以用 flomo doctor。
  if (resolved.readOnly || options.verify === false || !shouldVerifyAuth(auth)) {
    return { auth, verified: false, warnings: [], source: resolved.source };
  }

  const info = await verifyAuthToken({
    dataDir: options.dataDir,
    auth,
    contract: options.contract,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  const updated: AuthData = {
    ...auth,
    verifiedAt: new Date().toISOString(),
    ...(info.userId !== undefined ? { userId: info.userId } : {}),
    ...(info.nickname !== undefined ? { nickname: info.nickname } : {}),
  };
  const warnings = saveAuth(options.dataDir, updated);
  options.onWarn?.(
    `鉴权文件校验通过${info.nickname ? `（${info.nickname}）` : ''}：${authFile(options.dataDir)}`,
  );

  return { auth: updated, verified: true, warnings, source: resolved.source };
}

export async function createClient(options: CreateClientOptions = {}): Promise<CreateClientResult> {
  const dataDir = resolveDataDir(options.dataDir);
  const contractState = await loadContract(dataDir, {
    refresh: options.refreshContract,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const warnings = [...contractState.warnings];
  for (const warning of warnings) options.onWarn?.(warning);

  const authResult = await ensureAuthReady({
    dataDir,
    contract: contractState.contract,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options.verifyAuth !== undefined ? { verify: options.verifyAuth } : {}),
  });
  warnings.push(...authResult.warnings);

  const client = new FlomoClient({
    dataDir,
    auth: authResult.auth,
    contract: contractState.contract,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  return {
    client,
    auth: authResult.auth,
    authSource: authResult.source,
    dataDir,
    contractState,
    warnings,
  };
}

export function dataFile(dataDir: string, name: string): string {
  return path.join(dataDir, name);
}
