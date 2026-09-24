import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authFile,
  buildAuth,
  clearAuth,
  readAuth,
  requireAuth,
  resolveAuth,
  saveAuth,
} from '../src/core/auth';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-auth-'));
}

describe('凭据存取', () => {
  it('保存后可以读回', () => {
    const dir = tmpDir();
    const auth = buildAuth({ accessToken: 'tok', deviceId: 'dev-1', deviceModel: 'Windows' });
    saveAuth(dir, auth);
    expect(readAuth(dir)).toEqual(auth);
    expect(fs.existsSync(authFile(dir))).toBe(true);
  });

  it('缺少凭据时 readAuth 返回 null，requireAuth 抛鉴权错误', () => {
    const dir = tmpDir();
    expect(readAuth(dir)).toBeNull();
    expect(() => requireAuth(dir)).toThrowError(/flomo auth login/);
    try {
      requireAuth(dir);
    } catch (error) {
      expect((error as { kind: string }).kind).toBe('AUTH');
      expect((error as { exitCode: number }).exitCode).toBe(3);
    }
  });

  it('格式损坏时视为无凭据', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(authFile(dir), '{"accessToken":""}', 'utf8');
    expect(readAuth(dir)).toBeNull();
  });

  it('logout 会删除凭据文件', () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'tok' }));
    expect(clearAuth(dir)).toHaveLength(1);
    expect(readAuth(dir)).toBeNull();
  });
});

describe('buildAuth', () => {
  it('缺省时自动生成 device-id 与 platform', () => {
    const auth = buildAuth({ accessToken: 'tok' });
    expect(auth.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(auth.platform).toBe('web');
    expect(auth.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('保留调用方传入的账号信息', () => {
    const auth = buildAuth({ accessToken: 'tok', userId: 42, nickname: '阿吉' });
    expect(auth.userId).toBe(42);
    expect(auth.nickname).toBe('阿吉');
  });
});

describe('resolveAuth（凭据来源解析）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('既没有环境变量也没有文件 → null', () => {
    expect(resolveAuth(tmpDir())).toBeNull();
  });

  it('只有文件 → source=file 且可写', () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'file-token', deviceId: 'dev-file' }));
    const resolved = resolveAuth(dir);
    expect(resolved).toMatchObject({ source: 'file', readOnly: false });
    expect(resolved?.auth.accessToken).toBe('file-token');
  });

  it('FLOMO_TOKEN 裸 token → 只读，deviceId 自动生成', () => {
    vi.stubEnv('FLOMO_TOKEN', 'env-token');
    const resolved = resolveAuth(tmpDir());
    expect(resolved).toMatchObject({ source: 'env:FLOMO_TOKEN', readOnly: true });
    expect(resolved?.auth.accessToken).toBe('env-token');
    expect(resolved?.auth.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FLOMO_AUTH_JSON 保留 deviceId/platform/deviceModel', () => {
    vi.stubEnv(
      'FLOMO_AUTH_JSON',
      JSON.stringify({
        accessToken: 'json-token',
        deviceId: 'dev-json',
        platform: 'Web',
        deviceModel: 'Edge',
        userId: 42,
      }),
    );
    const resolved = resolveAuth(tmpDir());
    expect(resolved).toMatchObject({ source: 'env:FLOMO_AUTH_JSON', readOnly: true });
    expect(resolved?.auth).toMatchObject({
      accessToken: 'json-token',
      deviceId: 'dev-json',
      deviceModel: 'Edge',
      userId: 42,
    });
  });

  it('FLOMO_AUTH_FILE 从外部文件读取，不复制进配置目录', () => {
    const external = path.join(tmpDir(), 'external-auth.json');
    fs.writeFileSync(
      external,
      JSON.stringify({ accessToken: 'ext-token', deviceId: 'dev-ext', platform: 'Web', deviceModel: 'Chrome' }),
      'utf8',
    );
    vi.stubEnv('FLOMO_AUTH_FILE', external);

    const dir = tmpDir();
    const resolved = resolveAuth(dir);
    expect(resolved).toMatchObject({ source: 'env:FLOMO_AUTH_FILE', readOnly: true, path: external });
    expect(resolved?.auth.accessToken).toBe('ext-token');
    expect(fs.existsSync(authFile(dir))).toBe(false);
  });

  it('FLOMO_AUTH_FILE 指向不存在的文件 → AUTH 错误点名该变量', () => {
    vi.stubEnv('FLOMO_AUTH_FILE', path.join(tmpDir(), 'missing.json'));
    expect(() => resolveAuth(tmpDir())).toThrowError(/FLOMO_AUTH_FILE/);
  });

  it('环境变量优先于配置目录里的文件', () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'file-token' }));
    vi.stubEnv('FLOMO_TOKEN', 'env-token');
    expect(resolveAuth(dir)?.auth.accessToken).toBe('env-token');
    expect(resolveAuth(dir)?.source).toBe('env:FLOMO_TOKEN');
  });

  it('环境变量内容非法 → AUTH 错误并点明变量名', () => {
    vi.stubEnv('FLOMO_TOKEN', '{这不是 JSON');
    expect(() => resolveAuth(tmpDir())).toThrowError(/FLOMO_TOKEN 解析失败/);
  });
});
