import { FlomoError } from './errors.js';

/**
 * 让用户在浏览器里自助取出鉴权信息。
 * 需在已登录的 flomo 页面（https://v.flomoapp.com/mine）的 DevTools Console 里执行。
 */
export const CONSOLE_SNIPPET = `(() => {
  const me = JSON.parse(localStorage.getItem('me') || '{}');
  if (!me.access_token) {
    console.error('未检测到 access_token：请先在 https://v.flomoapp.com/mine 完成 flomo 登录');
    return null;
  }
  const ua = navigator.userAgent;
  const auth = {
    accessToken: me.access_token,
    deviceId: localStorage.getItem('device_id') || '',
    platform: 'Web',
    deviceModel: ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome/') ? 'Chrome' : 'Web',
    userId: me.id ?? me.user_id,
    nickname: me.nickname,
    savedAt: new Date().toISOString()
  };
  const json = JSON.stringify(auth);
  if (typeof copy === 'function') {
    copy(json);
    console.log('已复制到剪贴板，可直接粘贴给：flomo setup --import -');
  }
  console.log(json);
  return auth;
})()`;

export const AUTH_VERIFY_TTL_MS = 12 * 60 * 60 * 1000;

export interface ImportedAuthFields {
  accessToken: string;
  deviceId?: string;
  platform?: string;
  deviceModel?: string;
  userId?: string | number;
  nickname?: string;
}

export type SetupInput =
  | { kind: 'stdin' }
  | { kind: 'json'; text: string }
  | { kind: 'file'; path: string };

/**
 * `--import` 的取值有三种形态：
 * - `-`：从标准输入读
 * - 以 `{` 开头：直接当 JSON 字面量（PowerShell 里需要引号包住，否则会被当成脚本块）
 * - 其它：当成文件路径
 */
export function classifyImportValue(value: string): SetupInput {
  const trimmed = value.trim();
  if (trimmed === '-') return { kind: 'stdin' };
  if (trimmed.startsWith('{')) return { kind: 'json', text: trimmed };
  return { kind: 'file', path: trimmed };
}

/** 判断缓冲区里是否已经是一份完整的 JSON 对象（用于"粘贴后回车即可"的交互体验）。 */
export function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * 解析用户粘贴的内容，支持三种形态：
 * - 控制台输出的 JSON（含 accessToken / deviceId ...）
 * - 现成的 auth.json 内容
 * - 裸 token 字符串
 */
export function parseImportedAuth(input: string): ImportedAuthFields {
  const text = input.trim().replace(/^["']|["']$/g, '');
  if (!text) {
    throw new FlomoError('USAGE', '导入内容为空：请粘贴控制台输出的 JSON，或用 --token <token> 指定');
  }

  if (text.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new FlomoError('USAGE', '导入内容看起来是 JSON，但无法解析', { cause: error });
    }

    const accessToken = firstString(parsed.accessToken, parsed.access_token, parsed.token);
    if (!accessToken) {
      throw new FlomoError('USAGE', 'JSON 中缺少 accessToken，请确认粘贴的是控制台输出的完整内容');
    }

    const fields: ImportedAuthFields = { accessToken };
    const deviceId = firstString(parsed.deviceId, parsed.device_id);
    if (deviceId) fields.deviceId = deviceId;
    const platform = firstString(parsed.platform);
    if (platform) fields.platform = platform;
    const deviceModel = firstString(parsed.deviceModel, parsed.device_model);
    if (deviceModel) fields.deviceModel = deviceModel;
    const userId = parsed.userId ?? parsed.user_id;
    if (typeof userId === 'string' || typeof userId === 'number') fields.userId = userId;
    const nickname = firstString(parsed.nickname);
    if (nickname) fields.nickname = nickname;
    return fields;
  }

  if (/\s/.test(text)) {
    throw new FlomoError('USAGE', '无法识别的内容：token 不应包含空白字符；JSON 请完整粘贴');
  }
  return { accessToken: text };
}

/** 首次使用（或太久没校验）时才需要联网验证鉴权文件。 */
export function shouldVerifyAuth(
  auth: { verifiedAt?: string | undefined },
  now = Date.now(),
  maxAgeMs = AUTH_VERIFY_TTL_MS,
): boolean {
  if (!auth.verifiedAt) return true;
  const verifiedAt = Date.parse(auth.verifiedAt);
  if (Number.isNaN(verifiedAt)) return true;
  return now - verifiedAt > maxAgeMs;
}

export function missingAuthMessage(dataDir: string, authPath: string): string {
  return [
    `首次使用：配置目录 ${dataDir} 下没有鉴权文件。`,
    `  期望路径：${authPath}`,
    '  请执行 flomo setup 获取引导：它会打印一段 Chromium 控制台代码，',
    '  在已登录的 https://v.flomoapp.com/mine 页面执行后把结果导入即可。',
  ].join('\n');
}

export function invalidAuthMessage(reason: string): string {
  return `鉴权文件不可用：${reason}`;
}
