import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FlomoError, errorMessage } from './errors.js';
import { parseImportedAuth } from './onboarding.js';
import { ensureDir, restrictAccess } from './paths.js';

export const authSchema = z.object({
  accessToken: z.string().min(1),
  deviceId: z.string().min(1),
  platform: z.string().min(1),
  deviceModel: z.string().min(1),
  userId: z.union([z.string(), z.number()]).optional(),
  nickname: z.string().optional(),
  savedAt: z.string().min(1),
  /** 上次验证可用性的时间；首次启动与过期后会自动校验 */
  verifiedAt: z.string().optional(),
});

export type AuthData = z.infer<typeof authSchema>;

/** 凭据来源，便于 doctor / auth status 明确告诉调用方"现在用的是哪一份凭据"。 */
export type AuthSource =
  | 'file'
  | 'env:FLOMO_AUTH_JSON'
  | 'env:FLOMO_AUTH_FILE'
  | 'env:FLOMO_TOKEN';

export interface ResolvedAuth {
  auth: AuthData;
  source: AuthSource;
  /** 只读来源（环境变量）不会被写回，也不会写入配置目录 */
  readOnly: boolean;
  path?: string;
}

export function authFile(dataDir: string): string {
  return path.join(dataDir, 'auth.json');
}

export function storageStateFile(dataDir: string): string {
  return path.join(dataDir, 'state.json');
}

export function profileDir(dataDir: string): string {
  return path.join(dataDir, 'profile');
}

export function logsDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}

export function readAuth(dataDir: string): AuthData | null {
  let raw: string;
  try {
    raw = fs.readFileSync(authFile(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = authSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function requireAuth(dataDir: string): AuthData {
  const auth = readAuth(dataDir);
  if (!auth) {
    throw new FlomoError(
      'AUTH',
      `未找到登录凭据（${authFile(dataDir)}）。请先执行 flomo auth login，或设置 FLOMO_HOME 指向已有凭据目录`,
    );
  }
  return auth;
}

function authFromText(text: string, label: string): AuthData {
  let imported;
  try {
    imported = parseImportedAuth(text);
  } catch (error) {
    throw new FlomoError('AUTH', `${label} 解析失败：${errorMessage(error)}`, { cause: error });
  }
  return buildAuth({
    accessToken: imported.accessToken,
    ...(imported.deviceId !== undefined ? { deviceId: imported.deviceId } : {}),
    ...(imported.platform !== undefined ? { platform: imported.platform } : {}),
    ...(imported.deviceModel !== undefined ? { deviceModel: imported.deviceModel } : {}),
    ...(imported.userId !== undefined ? { userId: imported.userId } : {}),
    ...(imported.nickname !== undefined ? { nickname: imported.nickname } : {}),
  });
}

/**
 * 解析本次调用使用的凭据，按顺序取第一个命中的：
 *
 * 1. `FLOMO_AUTH_JSON` —— 整份控制台 JSON（推荐，保留 deviceId/platform/deviceModel）
 * 2. `FLOMO_AUTH_FILE` —— 指向任意位置的鉴权 JSON 文件（只读，不复制进配置目录）
 * 3. `FLOMO_TOKEN`     —— 裸 token 或整份 JSON（deviceId 自动生成）
 * 4. 配置目录下的 `auth.json`
 *
 * 环境变量优先于文件：自动化场景里"显式注入"应当压过磁盘上的旧状态。
 * 环境变量提供的凭据一律只读（不写 verifiedAt、不建目录），便于容器与只读挂载。
 */
export function resolveAuth(dataDir: string): ResolvedAuth | null {
  const fromEnvJson = process.env.FLOMO_AUTH_JSON?.trim();
  if (fromEnvJson) {
    return {
      auth: authFromText(fromEnvJson, 'FLOMO_AUTH_JSON'),
      source: 'env:FLOMO_AUTH_JSON',
      readOnly: true,
    };
  }

  const fromEnvFile = process.env.FLOMO_AUTH_FILE?.trim();
  if (fromEnvFile) {
    const filePath = path.resolve(fromEnvFile);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new FlomoError('AUTH', `FLOMO_AUTH_FILE 指向的文件无法读取：${filePath}`, {
        cause: error,
      });
    }
    return {
      auth: authFromText(raw, 'FLOMO_AUTH_FILE'),
      source: 'env:FLOMO_AUTH_FILE',
      readOnly: true,
      path: filePath,
    };
  }

  const fromEnvToken = process.env.FLOMO_TOKEN?.trim();
  if (fromEnvToken) {
    return {
      auth: authFromText(fromEnvToken, 'FLOMO_TOKEN'),
      source: 'env:FLOMO_TOKEN',
      readOnly: true,
    };
  }

  const fromFile = readAuth(dataDir);
  if (fromFile) {
    return { auth: fromFile, source: 'file', readOnly: false, path: authFile(dataDir) };
  }

  return null;
}

export function saveAuth(dataDir: string, auth: AuthData): string[] {
  ensureDir(dataDir);
  const file = authFile(dataDir);
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  const warnings = restrictAccess(file);
  ensureDir(logsDir(dataDir));
  return warnings;
}

export function saveStorageState(dataDir: string, state: unknown): string[] {
  ensureDir(dataDir);
  const file = storageStateFile(dataDir);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return restrictAccess(file);
}

export function clearAuth(dataDir: string): string[] {
  const removed: string[] = [];
  for (const file of [authFile(dataDir), storageStateFile(dataDir)]) {
    try {
      if (!fs.existsSync(file)) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      /* 忽略：删除失败不应该阻塞 logout */
    }
  }
  return removed;
}

export function newDeviceId(): string {
  return randomUUID();
}

/** 未捕获到浏览器真实请求头时的兜底 device-model。 */
export function defaultDeviceModel(): string {
  const platform = process.platform;
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Macintosh';
  return 'Linux';
}

export interface AuthPatch {
  accessToken: string;
  deviceId?: string;
  platform?: string;
  deviceModel?: string;
  userId?: string | number;
  nickname?: string;
}

export function buildAuth(patch: AuthPatch): AuthData {
  const auth: AuthData = {
    accessToken: patch.accessToken,
    deviceId: patch.deviceId?.trim() || newDeviceId(),
    platform: patch.platform?.trim() || 'web',
    deviceModel: patch.deviceModel?.trim() || defaultDeviceModel(),
    savedAt: new Date().toISOString(),
  };
  if (patch.userId !== undefined) auth.userId = patch.userId;
  if (patch.nickname !== undefined) auth.nickname = patch.nickname;
  return auth;
}
