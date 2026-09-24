import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR_ENV = 'FLOMO_HOME';

/** 包根目录：dist/core 与 src/core 都回退两级，保证编译前后一致。 */
export function packageRoot(): string {
  return path.resolve(moduleDir, '..', '..');
}

export function resolveDataDir(explicit?: string | undefined): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return path.resolve(fromFlag);
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(packageRoot(), '.flomo');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 尽力收紧文件权限，失败只返回告警而不中断流程。
 * 凭据文件等价于账号密码，能限制访问就限制。
 */
export function restrictAccess(target: string): string[] {
  const warnings: string[] = [];
  try {
    if (process.platform === 'win32') {
      const domain = process.env.USERDOMAIN;
      const user = process.env.USERNAME;
      const account = domain && user ? `${domain}\\${user}` : user;
      if (!account) return warnings;
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${account}:(F)`], {
        stdio: 'ignore',
      });
    } else {
      fs.chmodSync(target, 0o600);
    }
  } catch (error) {
    warnings.push(`无法收紧 ${target} 的访问权限：${error instanceof Error ? error.message : String(error)}`);
  }
  return warnings;
}
