import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveUserAgent, USER_AGENT } from '../src/core/contract';
import { buildHeaders } from '../src/core/http';
import {
  browserCandidates,
  resolveBrowserArgument,
  stdinEndHint,
} from '../src/core/platform';

const AUTH = {
  accessToken: 'tok',
  deviceId: 'dev',
  platform: 'Web',
  deviceModel: 'Edge',
  savedAt: '2026-09-24T00:00:00.000Z',
};

describe('browserCandidates', () => {
  it('Windows 优先 Edge', () => {
    expect(browserCandidates('win32')[0]).toBe('msedge');
  });

  it('macOS 优先 Chrome', () => {
    expect(browserCandidates('darwin')[0]).toBe('chrome');
  });

  it('Linux 不包含只在该平台少见的 Edge，且都以 Chromium 兜底', () => {
    expect(browserCandidates('linux')).toEqual(['chrome', 'chromium']);
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(browserCandidates(platform).at(-1)).toBe('chromium');
    }
  });
});

describe('resolveBrowserArgument', () => {
  it('未指定时返回 null，交由平台默认', () => {
    expect(resolveBrowserArgument(undefined)).toBeNull();
    expect(resolveBrowserArgument('  ')).toBeNull();
  });

  it('显式取值返回单一候选，并兼容 edge 别名', () => {
    expect(resolveBrowserArgument('chrome')).toEqual(['chrome']);
    expect(resolveBrowserArgument('edge')).toEqual(['msedge']);
    expect(resolveBrowserArgument('msedge')).toEqual(['msedge']);
    expect(resolveBrowserArgument('chromium')).toEqual(['chromium']);
  });

  it('非法取值抛用法错误', () => {
    expect(() => resolveBrowserArgument('firefox')).toThrowError(/不支持的 --browser 取值/);
  });
});

describe('stdinEndHint', () => {
  it('Windows 用 Ctrl+Z', () => {
    expect(stdinEndHint('win32')).toContain('Ctrl+Z');
  });

  it('类 Unix 用 Ctrl+D', () => {
    expect(stdinEndHint('darwin')).toBe('Ctrl+D');
    expect(stdinEndHint('linux')).toBe('Ctrl+D');
  });
});

describe('USER_AGENT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('默认是模拟网页客户端的协议常量，不随宿主平台变化', () => {
    expect(resolveUserAgent()).toBe(USER_AGENT);
    expect(buildHeaders(AUTH)['user-agent']).toBe(USER_AGENT);
  });

  it('可用 FLOMO_USER_AGENT 覆盖', () => {
    vi.stubEnv('FLOMO_USER_AGENT', 'custom-agent/1.0');
    expect(resolveUserAgent()).toBe('custom-agent/1.0');
    expect(buildHeaders(AUTH)['user-agent']).toBe('custom-agent/1.0');
  });
});
