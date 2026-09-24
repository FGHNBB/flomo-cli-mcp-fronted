import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTRACT,
  extractAppVersion,
  extractContract,
  fetchContract,
  loadContract,
  pickIndexBundleUrl,
  readCachedContract,
  saveContract,
  type FetchLike,
} from '../src/core/contract';

/** 取自 flomo-web 5.26.x 线上 bundle 的压缩代码片段（保留关键结构）。 */
const BUNDLE_FIXTURE = [
  'static _getSign(e){e=this._ksort(e);let t="";for(let i in e){let n=e[i];',
  'if(void 0!==n&&(n||0===n))if(Array.isArray(n)){n.sort(function(e,t){return e&&t?',
  'e.toString().localeCompare(t.toString()):0});for(let e in n)t+=i+"[]="+n[e]+"&"}',
  'else t+=i+"="+n+"&"}return t=t.substring(0,t.length-1),',
  'm(t+"dbbc3dd73364b4084c3a69346e0ce2b2")}',
  'static prepareParams(e={},t=""){let i="/user/me"===t?{}:{...e};i.timestamp=p().unix(),',
  'i.api_key="flomo_web",i.app_version="2.0",i.platform="web",',
  '{NODE_ENV:"production",VUE_APP_VERSION:"5.26.91"}.IS_ELECTRON?',
  '(i.app_version=this.getPackageVersion(),i.platform=this.getPlatform()):i.app_version="4.0"}',
  'static BASE_URL="https://flomoapp.com/api/v1",BASE_URL_PROD_V2="https://flomoapp.com/api/v2",',
  'BASE_URL_TEST="https://stage.flomoapp.com/api/v1"',
].join('');

const PAGE_HTML = [
  '<!doctype html><html><head>',
  '<script src="./lowTipBrowserVersion.js"></script>',
  '<script src="https://resource.flomoapp.com/flomo-web/js/runtime.8e472707.js"></script>',
  '<script src="https://resource.flomoapp.com/flomo-web/js/index.9635b9da.js"></script>',
  '</head></html>',
].join('');

function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body: string }>): FetchLike {
  return async (input: string) => {
    const route = routes[input];
    if (!route) throw new Error(`unexpected fetch: ${input}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => route.body,
    } as unknown as Response;
  };
}

describe('pickIndexBundleUrl', () => {
  it('优先选择 index.<hash>.js', () => {
    expect(pickIndexBundleUrl(PAGE_HTML, 'https://v.flomoapp.com/mine')).toBe(
      'https://resource.flomoapp.com/flomo-web/js/index.9635b9da.js',
    );
  });

  it('没有 index 脚本时抛契约错误', () => {
    expect(() => pickIndexBundleUrl('<html></html>')).toThrowError(/bundle/);
  });
});

describe('extractAppVersion', () => {
  it('优先取三元分支里的值', () => {
    expect(extractAppVersion(BUNDLE_FIXTURE)).toBe('4.0');
  });

  it('没有分支结构时退回最后一个 app_version', () => {
    expect(extractAppVersion('a.app_version="1.0";b.app_version="3.5"')).toBe('3.5');
  });
});

describe('extractContract', () => {
  it('提取盐值、api_key 与 v1/v2 基址', () => {
    const contract = extractContract(BUNDLE_FIXTURE, 'https://example.test/index.js', '2026-09-24T00:00:00.000Z');
    expect(contract.signSalt).toBe('dbbc3dd73364b4084c3a69346e0ce2b2');
    expect(contract.apiKey).toBe('flomo_web');
    expect(contract.baseV1).toBe('https://flomoapp.com/api/v1');
    expect(contract.baseV2).toBe('https://flomoapp.com/api/v2');
    expect(contract.appVersion).toBe('4.0');
    expect(contract.platform).toBe('web');
    expect(contract.fetchedAt).toBe('2026-09-24T00:00:00.000Z');
  });

  it('缺少盐值时抛契约错误', () => {
    expect(() => extractContract('api_key="flomo_web"', 'x')).toThrowError(/盐值/);
  });
});

describe('fetchContract', () => {
  it('先取页面再取 bundle', async () => {
    const contract = await fetchContract(
      fakeFetch({
        'https://v.flomoapp.com/mine': { body: PAGE_HTML },
        'https://resource.flomoapp.com/flomo-web/js/index.9635b9da.js': { body: BUNDLE_FIXTURE },
      }),
    );
    expect(contract.signSalt).toBe(DEFAULT_CONTRACT.signSalt);
    expect(contract.sourceUrl).toBe('https://resource.flomoapp.com/flomo-web/js/index.9635b9da.js');
  });

  it('页面请求失败时抛网络错误', async () => {
    const failing: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(fetchContract(failing)).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});

describe('契约缓存', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-contract-'));

  it('写入后可读回', () => {
    saveContract(dataDir, { ...DEFAULT_CONTRACT, signSalt: 'a'.repeat(32) });
    expect(readCachedContract(dataDir)?.signSalt).toBe('a'.repeat(32));
  });

  it('缓存新鲜时直接复用，不发起网络请求', async () => {
    saveContract(dataDir, { ...DEFAULT_CONTRACT, fetchedAt: new Date().toISOString() });
    const state = await loadContract(dataDir, {
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });
    expect(state.source).toBe('cache');
    expect(state.warnings).toEqual([]);
  });

  it('缓存过期且抓取失败时，回退到缓存并给出告警', async () => {
    saveContract(dataDir, { ...DEFAULT_CONTRACT, fetchedAt: '2000-01-01T00:00:00.000Z' });
    const state = await loadContract(dataDir, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(state.source).toBe('cache');
    expect(state.warnings[0]).toMatch(/契约提取失败/);
  });

  it('配置目录不可写时仍使用抓到的契约，只给出告警（容器/只读挂载场景）', async () => {
    const unwritable = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-contract-ro-')), 'not-a-dir');
    fs.writeFileSync(unwritable, 'x', 'utf8');

    const state = await loadContract(unwritable, {
      fetchImpl: fakeFetch({
        'https://v.flomoapp.com/mine': { body: PAGE_HTML },
        'https://resource.flomoapp.com/flomo-web/js/index.9635b9da.js': { body: BUNDLE_FIXTURE },
      }),
    });
    expect(state.source).toBe('fetched');
    expect(state.contract.signSalt).toBe(DEFAULT_CONTRACT.signSalt);
    expect(state.warnings[0]).toMatch(/契约缓存写入失败/);
  });

  it('无缓存且抓取失败时退回内置默认值', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flomo-contract-empty-'));
    const state = await loadContract(emptyDir, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(state.source).toBe('default');
    expect(state.contract).toEqual(DEFAULT_CONTRACT);
  });
});
