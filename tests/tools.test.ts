import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT, errorMessage, FlomoError } from '../src/core/index.js';
import { runTool, type ToolDeps } from '../src/context.js';
import { clampInt, shapeNote } from '../src/truncate.js';
import { getTool, healthTool, listTool, searchTool } from '../src/tools/read.js';
import { appendTool, createTool, deleteTool, replaceTool } from '../src/tools/write.js';

interface Call {
  method: string;
  path: string;
  options: any;
}

interface World {
  notes: Map<string, string>;
  calls: Call[];
}

function makeWorld(initial: Record<string, string> = {}): World {
  return { notes: new Map(Object.entries(initial)), calls: [] };
}

/** 假客户端：实现工具真正会用到的那几个接口形态。 */
function makeClient(world: World, overrides: { afterWrite?: (slug: string) => string | null } = {}): any {
  return {
    baseV1: 'https://flomoapp.com/api/v1',
    baseV2: 'https://flomoapp.com/api/v2',
    timezone: '8:0',
    currentContract: DEFAULT_CONTRACT,
    async call(method: string, path: string, options: any = {}): Promise<any> {
      world.calls.push({ method, path, options });

      if (path === '/user/me') return { id: 42, name: '测试账号' };
      if (path === '/tag/tree') return { tag_tree: [], updated_at: null };

      if (path === '/memo/updated/') {
        return [...world.notes.entries()].map(([slug, content], index) => ({
          slug,
          content,
          created_at: `2026-09-2${index} 10:00:00`,
          updated_at: `2026-09-2${index} 10:00:00`,
          tags: [],
        }));
      }

      if (method === 'GET' && path.startsWith('/memo/')) {
        const slug = decodeURIComponent(path.slice('/memo/'.length));
        const override = overrides.afterWrite?.(slug);
        const content = override ?? world.notes.get(slug);
        if (content === undefined) {
          throw new FlomoError('API', `笔记 ${slug} 不存在或已被删除（服务端 code -1）`, {
            details: { code: -1 },
          });
        }
        return { slug, content, created_at: '2026-09-24 10:00:00', updated_at: '2026-09-24 10:00:00', tags: [] };
      }

      if (method === 'POST' && path === '/memo') {
        const content = String(options.body.content);
        const slug = `slug-${world.notes.size + 1}`;
        world.notes.set(slug, content);
        return { slug, content };
      }

      if (method === 'PUT' && path.startsWith('/memo/')) {
        const slug = decodeURIComponent(path.slice('/memo/'.length));
        if (!world.notes.has(slug)) {
          throw new FlomoError('API', '笔记不存在', { details: { code: -1 } });
        }
        world.notes.set(slug, String(options.body.content));
        return { slug, content: options.body.content };
      }

      if (method === 'DELETE') {
        const slugs: string[] = Array.isArray(options.body?.memo_slugs)
          ? options.body.memo_slugs
          : [decodeURIComponent(path.slice('/memo/'.length))];
        for (const slug of slugs) world.notes.delete(slug);
        return null;
      }

      throw new Error(`未预期的请求：${method} ${path}`);
    },
  };
}

function makeDeps(
  world: World,
  options: {
    overrides?: { afterWrite?: (slug: string) => string | null };
    clientOverride?: any;
    authSource?: string;
    failWith?: Error;
  } = {},
): ToolDeps {
  const authSource = options.authSource ?? 'env:FLOMO_AUTH_JSON';
  return {
    dataDir: '/tmp/flomo-mcp-test',
    onWarn: () => {},
    createClientImpl: (async () => {
      if (options.failWith) throw options.failWith;
      const client = options.clientOverride ?? makeClient(world, options.overrides);
      return {
        client,
        auth: { accessToken: 'tok', deviceId: 'dev', platform: 'Web', deviceModel: 'Edge', savedAt: '2026-09-24T00:00:00.000Z' },
        authSource,
        dataDir: '/tmp/flomo-mcp-test',
        contractState: { contract: DEFAULT_CONTRACT, source: 'cache', warnings: [] },
        warnings: [],
      };
    }) as any,
    resolveAuthImpl: () => ({
      auth: { accessToken: 'tok', deviceId: 'dev', platform: 'Web', deviceModel: 'Edge', savedAt: '2026-09-24T00:00:00.000Z' },
      source: authSource as any,
      readOnly: authSource.startsWith('env:'),
    }),
  };
}

function parse(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0]!.text);
}

describe('truncate', () => {
  const note = (length: number) => ({
    id: 'n1',
    created_at: '2026-09-24 10:00:00',
    updated_at: '2026-09-24 10:00:00',
    tags: [],
    content: 'x'.repeat(length),
  });

  it('799/800 字符不截断，801 字符截断', () => {
    expect(shapeNote(note(799)).truncated).toBe(false);
    expect(shapeNote(note(800)).truncated).toBe(false);
    const cut = shapeNote(note(801));
    expect(cut.truncated).toBe(true);
    expect(cut.content_length).toBe(801);
    expect(cut.content.endsWith('…')).toBe(true);
  });

  it('full=true 绕过截断', () => {
    const full = shapeNote(note(5000), { full: true });
    expect(full.truncated).toBe(false);
    expect(full.content.length).toBe(5000);
    expect(full.content_length).toBe(5000);
  });

  it('clampInt 夹取与回落', () => {
    expect(clampInt(500, 1, 200, 20)).toBe(200);
    expect(clampInt(0, 1, 200, 20)).toBe(1);
    expect(clampInt(undefined, 1, 200, 20)).toBe(20);
    expect(clampInt('abc', 1, 200, 20)).toBe(20);
  });
});

describe('flomo_list', () => {
  it('limit 会被夹到上限 200', async () => {
    const world = makeWorld({ a: '内容 A' });
    await runTool('flomo_list', makeDeps(world), (ctx) => listTool.run({ limit: 500 }, ctx));
    const listCall = world.calls.find((call) => call.path === '/memo/updated/');
    expect(listCall?.options.params.limit).toBe(200);
  });

  it('默认 limit 为 20 且正文已去壳', async () => {
    const world = makeWorld({ a: '<p>HTML 正文</p>' });
    const result = parse(await runTool('flomo_list', makeDeps(world), (ctx) => listTool.run({}, ctx)));
    expect(world.calls.find((call) => call.path === '/memo/updated/')?.options.params.limit).toBe(200);
    expect(result.result.notes[0].content).toBe('HTML 正文');
    expect(result.result.count).toBe(1);
  });

  it('tag 过滤包含子标签', async () => {
    const world = makeWorld({ a: '读书笔记 #读书', b: '小说 #读书/小说', c: '无关 #其他' });
    const result = parse(await runTool('flomo_list', makeDeps(world), (ctx) => listTool.run({ tag: '读书' }, ctx)));
    expect(result.result.notes.map((note: any) => note.id).sort()).toEqual(['a', 'b']);
  });
});

describe('flomo_get', () => {
  it('超过 20 个 ID 报用法错误', async () => {
    const world = makeWorld({ a: 'x' });
    const ids = Array.from({ length: 21 }, (_, index) => `id-${index}`);
    const result = await runTool('flomo_get', makeDeps(world), (ctx) => getTool.run({ ids }, ctx));
    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe('USAGE');
  });

  it('部分失败记入 failures，其余正常返回', async () => {
    const world = makeWorld({ a: '内容 A' });
    const result = parse(
      await runTool('flomo_get', makeDeps(world), (ctx) => getTool.run({ ids: ['a', 'missing'] }, ctx)),
    );
    expect(result.result.count).toBe(1);
    expect(result.result.failures).toHaveLength(1);
    expect(result.result.failures[0].id).toBe('missing');
  });

  it('全部失败返回 isError', async () => {
    const world = makeWorld({});
    const result = await runTool('flomo_get', makeDeps(world), (ctx) => getTool.run({ ids: ['missing'] }, ctx));
    expect(result.isError).toBe(true);
  });
});

describe('flomo_search', () => {
  it('多关键词只扫描一次，按 OR 命中并受 maxResults 限制', async () => {
    const world = makeWorld({ a: 'alpha 内容', b: 'beta 内容', c: 'gamma 内容' });
    const result = parse(
      await runTool('flomo_search', makeDeps(world), (ctx) =>
        searchTool.run({ queries: ['alpha', 'beta'], maxResults: 1 }, ctx),
      ),
    );
    const scans = world.calls.filter((call) => call.path === '/memo/updated/');
    expect(scans).toHaveLength(1);
    expect(result.result.scanned).toBe(3);
    expect(result.result.count).toBe(1);
  });

  it('超过 5 个关键词报用法错误', async () => {
    const world = makeWorld({ a: 'x' });
    const result = await runTool('flomo_search', makeDeps(world), (ctx) =>
      searchTool.run({ queries: ['1', '2', '3', '4', '5', '6'] }, ctx),
    );
    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe('USAGE');
  });
});

describe('写类工具', () => {
  it('create 写入后回读校验通过', async () => {
    const world = makeWorld({});
    const result = parse(
      await runTool('flomo_create', makeDeps(world), (ctx) => createTool.run({ content: '新笔记' }, ctx)),
    );
    expect(result.result.verified).toBe(true);
    expect(result.result.action).toBe('create');
    expect([...world.notes.values()]).toContain('新笔记');
  });

  it('append 追加到末尾', async () => {
    const world = makeWorld({ a: '原始内容' });
    const result = parse(
      await runTool('flomo_append', makeDeps(world), (ctx) => appendTool.run({ id: 'a', content: '追加' }, ctx)),
    );
    expect(result.result.verified).toBe(true);
    expect(world.notes.get('a')).toBe('原始内容\n追加');
  });

  it('replace 整体替换', async () => {
    const world = makeWorld({ a: '原始内容' });
    const result = parse(
      await runTool('flomo_replace', makeDeps(world), (ctx) => replaceTool.run({ id: 'a', content: '替换后' }, ctx)),
    );
    expect(result.result.action).toBe('replace');
    expect(world.notes.get('a')).toBe('替换后');
  });

  it('回读不一致时返回 isError（服务端改写了内容）', async () => {
    const world = makeWorld({});
    const deps = makeDeps(world, { overrides: { afterWrite: () => '服务端改成了别的内容' } });
    const result = await runTool('flomo_create', deps, (ctx) => createTool.run({ content: '原始写入' }, ctx));
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.error.kind).toBe('API');
    expect(payload.error.details.expected).toContain('原始写入');
    expect(payload.error.details.actual).toContain('服务端改成了别的内容');
  });

  it('delete 删除后逐条确认不可读', async () => {
    const world = makeWorld({ a: 'x', b: 'y' });
    const result = parse(
      await runTool('flomo_delete', makeDeps(world), (ctx) => deleteTool.run({ ids: ['a', 'b'] }, ctx)),
    );
    expect(result.result.count).toBe(2);
    expect(world.notes.size).toBe(0);
  });

  it('delete 对不存在的 ID 幂等（视为已删除）', async () => {
    const world = makeWorld({});
    const result = await runTool('flomo_delete', makeDeps(world), (ctx) => deleteTool.run({ ids: ['missing'] }, ctx));
    expect(result.isError).toBeFalsy();
  });
});

describe('flomo_health 与错误映射', () => {
  it('健康检查返回凭据来源、账号与计数', async () => {
    const world = makeWorld({ a: '读书 #读书', b: '第二条' });
    const result = parse(await runTool('flomo_health', makeDeps(world), (ctx) => healthTool.run({}, ctx)));
    expect(result.result.authSource).toBe('env:FLOMO_AUTH_JSON');
    expect(result.result.readOnly).toBe(true);
    expect(result.result.account.name).toBe('测试账号');
    expect(result.result.memoCount).toBe(2);
    expect(result.result.tagSource).toBe('memos');
  });

  it('AUTH 错误带排查提示', async () => {
    const world = makeWorld({});
    const deps = makeDeps(world, {
      failWith: new FlomoError('AUTH', '首次使用：配置目录下没有鉴权文件'),
    });
    const result = await runTool('flomo_list', deps, (ctx) => listTool.run({}, ctx));
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.error.kind).toBe('AUTH');
    expect(payload.error.hint).toContain('FLOMO_AUTH_JSON');
  });

  it('其它错误类型原样保留（NETWORK / CONTRACT）', async () => {
    for (const kind of ['NETWORK', 'CONTRACT'] as const) {
      const deps = makeDeps(makeWorld({}), { failWith: new FlomoError(kind, `${kind} 故障`) });
      const result = await runTool('flomo_list', deps, (ctx) => listTool.run({}, ctx));
      expect(parse(result).error.kind).toBe(kind);
    }
  });

  it('错误信封里 tool 字段标明是哪个工具', async () => {
    const deps = makeDeps(makeWorld({}), { failWith: new Error('boom') });
    const result = await runTool('flomo_search', deps, (ctx) => searchTool.run({ queries: ['x'] }, ctx));
    expect(parse(result).tool).toBe('flomo_search');
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
});
