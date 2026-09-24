import {
  createClient,
  resolveAuth,
  toFlomoError,
  type AuthData,
  type FlomoClient,
  type ResolvedAuth,
} from './core/index.js';

/** 每个工具调用可用的上下文。 */
export interface ToolContext {
  client: FlomoClient;
  auth: ResolvedAuth;
  dataDir: string;
  warnings: string[];
}

export interface ToolDeps {
  dataDir?: string;
  onWarn?: (message: string) => void;
  /** 测试注入点：替换客户端创建 */
  createClientImpl?: typeof createClient;
  /** 测试注入点：替换凭据解析 */
  resolveAuthImpl?: (dataDir: string) => ResolvedAuth | null;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  /** MCP SDK 的回调返回类型要求带索引签名 */
  [key: string]: unknown;
  content: ToolTextContent[];
  isError?: boolean;
}

const AUTH_HINT =
  '请用环境变量注入凭据（推荐 FLOMO_AUTH_JSON，其次 FLOMO_AUTH_FILE / FLOMO_TOKEN），' +
  '或先执行 flomo setup 写入配置目录的 auth.json';

export function textResult(payload: unknown, isError = false): ToolResult {
  const result: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * 所有工具的统一执行入口：
 * - 成功 → { ok:true, tool, result, meta }
 * - 失败 → { ok:false, tool, result:null, error:{kind,message,details,hint?} } 且 isError
 * 工具实现只管返回业务载荷，凭据与错误处理都在这里收口。
 */
export async function runTool(
  tool: string,
  deps: ToolDeps,
  handler: (ctx: ToolContext) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const onWarn = deps.onWarn ?? (() => {});
  try {
    const created = await (deps.createClientImpl ?? createClient)({
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
      onWarn,
    });

    const resolve = deps.resolveAuthImpl ?? resolveAuth;
    const auth = resolve(created.dataDir) ?? {
      auth: created.auth,
      source: created.authSource,
      readOnly: created.authSource.startsWith('env:'),
    };

    const payload = await handler({
      client: created.client,
      auth,
      dataDir: created.dataDir,
      warnings: created.warnings,
    });

    return textResult({
      ok: true,
      tool,
      result: payload,
      meta: {
        authSource: auth.source,
        readOnly: auth.readOnly,
        dataDir: created.dataDir,
        warnings: created.warnings,
      },
    });
  } catch (error) {
    const flomoError = toFlomoError(error);
    const errorPayload: Record<string, unknown> = {
      kind: flomoError.kind,
      message: flomoError.message,
      details: flomoError.details ?? null,
    };
    if (flomoError.kind === 'AUTH') errorPayload.hint = AUTH_HINT;

    return textResult({ ok: false, tool, result: null, error: errorPayload }, true);
  }
}

/** 从鉴权数据里挑出可安全展示的账号信息。 */
export function authSummary(auth: AuthData): { userId: string | number | null; nickname: string | null } {
  return { userId: auth.userId ?? null, nickname: auth.nickname ?? null };
}
