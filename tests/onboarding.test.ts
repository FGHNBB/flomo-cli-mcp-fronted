import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuth, readAuth, saveAuth } from '../src/core/auth';
import { ensureAuthReady } from '../src/core/client';
import { DEFAULT_CONTRACT, type FetchLike } from '../src/core/contract';
import {
  AUTH_VERIFY_TTL_MS,
  classifyImportValue,
  isCompleteJson,
  parseImportedAuth,
  shouldVerifyAuth,
} from '../src/core/onboarding';
import { clipboardCommands } from '../src/core/platform';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-onboarding-'));
}

function fakeResponse(body: string, status = 200): Response {
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => body,
  } as unknown as Response;
}

describe('parseImportedAuth', () => {
  it('裸 token 直接可用', () => {
    expect(parseImportedAuth('20112390|GcJ5k6IOxcKfJ4KENIsNC9Y6C0OfsBOByX6reRom')).toEqual({
      accessToken: '20112390|GcJ5k6IOxcKfJ4KENIsNC9Y6C0OfsBOByX6reRom',
    });
  });

  it('带引号的 token 会去掉引号', () => {
    expect(parseImportedAuth('"tok-123"').accessToken).toBe('tok-123');
  });

  it('解析控制台输出的 JSON', () => {
    const input = JSON.stringify({
      accessToken: 'tok',
      deviceId: 'dev-1',
      platform: 'Web',
      deviceModel: 'Chrome',
      userId: 42,
      nickname: '阿吉',
      savedAt: '2026-09-24T00:00:00.000Z',
    });
    expect(parseImportedAuth(input)).toEqual({
      accessToken: 'tok',
      deviceId: 'dev-1',
      platform: 'Web',
      deviceModel: 'Chrome',
      userId: 42,
      nickname: '阿吉',
    });
  });

  it('兼容下划线字段名', () => {
    expect(
      parseImportedAuth(JSON.stringify({ access_token: 'tok', device_id: 'dev', user_id: '7' })),
    ).toMatchObject({ accessToken: 'tok', deviceId: 'dev', userId: '7' });
  });

  it('JSON 缺少 accessToken 时报错', () => {
    expect(() => parseImportedAuth('{"deviceId":"dev"}')).toThrowError(/缺少 accessToken/);
  });

  it('空输入与非法输入报错', () => {
    expect(() => parseImportedAuth('   ')).toThrowError(/导入内容为空/);
    expect(() => parseImportedAuth('{not json')).toThrowError(/无法解析/);
    expect(() => parseImportedAuth('a b c')).toThrowError(/不应包含空白字符/);
  });
});

describe('classifyImportValue', () => {
  it('- 表示标准输入', () => {
    expect(classifyImportValue('-')).toEqual({ kind: 'stdin' });
  });

  it('以 { 开头视为内联 JSON（允许两侧空白）', () => {
    expect(classifyImportValue('  {"accessToken":"tok"}  ')).toEqual({
      kind: 'json',
      text: '{"accessToken":"tok"}',
    });
  });

  it('其它情况视为文件路径', () => {
    expect(classifyImportValue('./auth.json')).toEqual({ kind: 'file', path: './auth.json' });
    expect(classifyImportValue('C:\\tmp\\auth.json')).toEqual({
      kind: 'file',
      path: 'C:\\tmp\\auth.json',
    });
  });
});

describe('isCompleteJson（粘贴后回车即结束输入的判定）', () => {
  it('完整对象视为可结束（允许前后空白与多行）', () => {
    expect(isCompleteJson('{"accessToken":"tok"}')).toBe(true);
    expect(isCompleteJson('  {"a":1}  ')).toBe(true);
    expect(isCompleteJson('{\n  "a": 1\n}\n')).toBe(true);
  });

  it('未闭合、空串、裸 token、数组都视为未完成', () => {
    expect(isCompleteJson('{"a":1')).toBe(false);
    expect(isCompleteJson('')).toBe(false);
    expect(isCompleteJson('20112390|abcdef')).toBe(false);
    expect(isCompleteJson('[1,2]')).toBe(false);
  });
});

describe('clipboardCommands', () => {
  it('Windows 用 powershell Get-Clipboard', () => {
    expect(clipboardCommands('win32')[0]).toEqual({
      command: 'powershell',
      args: ['-NoProfile', '-Command', 'Get-Clipboard'],
    });
  });

  it('macOS 用 pbpaste', () => {
    expect(clipboardCommands('darwin')[0]?.command).toBe('pbpaste');
  });

  it('Linux 依次尝试 wl-paste 与 xclip', () => {
    expect(clipboardCommands('linux').map((item) => item.command)).toEqual(['wl-paste', 'xclip']);
  });
});

describe('shouldVerifyAuth', () => {
  it('从未校验过 → 需要校验', () => {
    expect(shouldVerifyAuth({})).toBe(true);
  });

  it('刚校验过 → 不再校验', () => {
    expect(shouldVerifyAuth({ verifiedAt: new Date().toISOString() })).toBe(false);
  });

  it('超过有效期 → 需要重新校验', () => {
    const stale = new Date(Date.now() - AUTH_VERIFY_TTL_MS - 1000).toISOString();
    expect(shouldVerifyAuth({ verifiedAt: stale })).toBe(true);
  });

  it('时间戳损坏 → 需要校验', () => {
    expect(shouldVerifyAuth({ verifiedAt: 'not-a-date' })).toBe(true);
  });
});

describe('ensureAuthReady（首次启动引导）', () => {
  it('配置目录里没有 auth.json → 报 AUTH 并提示 flomo setup', async () => {
    const dir = tmpDir();
    await expect(ensureAuthReady({ dataDir: dir, contract: DEFAULT_CONTRACT })).rejects.toMatchObject({
      kind: 'AUTH',
      exitCode: 3,
    });
    await expect(ensureAuthReady({ dataDir: dir, contract: DEFAULT_CONTRACT })).rejects.toThrowError(
      /flomo setup/,
    );
  });

  it('首次启动会联网校验，并把校验结果写回 auth.json', async () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'tok', deviceId: 'dev-1' }));

    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return fakeResponse(JSON.stringify({ code: 0, data: { id: 42, name: '阿吉' } }));
    };

    const result = await ensureAuthReady({ dataDir: dir, contract: DEFAULT_CONTRACT, fetchImpl });
    expect(result.verified).toBe(true);
    expect(calls[0]).toContain('/user/me');

    const persisted = readAuth(dir);
    expect(persisted?.nickname).toBe('阿吉');
    expect(persisted?.userId).toBe(42);
    expect(persisted?.verifiedAt).toBeTruthy();
  });

  it('已校验且在有效期内 → 不再联网', async () => {
    const dir = tmpDir();
    saveAuth(dir, { ...buildAuth({ accessToken: 'tok' }), verifiedAt: new Date().toISOString() });

    const result = await ensureAuthReady({
      dataDir: dir,
      contract: DEFAULT_CONTRACT,
      fetchImpl: async () => {
        throw new Error('不应发起请求');
      },
    });
    expect(result.verified).toBe(false);
  });

  it('verify: false 时只读文件（供 --dry-run 使用）', async () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'tok' }));
    const result = await ensureAuthReady({
      dataDir: dir,
      contract: DEFAULT_CONTRACT,
      verify: false,
      fetchImpl: async () => {
        throw new Error('不应发起请求');
      },
    });
    expect(result.verified).toBe(false);
    expect(result.auth.accessToken).toBe('tok');
  });

  it('鉴权失效（业务码 -10）→ 抛 AUTH 并提示重新 setup', async () => {
    const dir = tmpDir();
    saveAuth(dir, buildAuth({ accessToken: 'expired' }));
    const fetchImpl: FetchLike = async () =>
      fakeResponse(JSON.stringify({ code: -10, message: '请先登录' }));

    await expect(ensureAuthReady({ dataDir: dir, contract: DEFAULT_CONTRACT, fetchImpl })).rejects.toMatchObject(
      { kind: 'AUTH', exitCode: 3 },
    );
    await expect(
      ensureAuthReady({ dataDir: dir, contract: DEFAULT_CONTRACT, fetchImpl }),
    ).rejects.toThrowError(/flomo setup/);
  });
});
