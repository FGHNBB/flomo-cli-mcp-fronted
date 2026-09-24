import { describe, expect, it } from 'vitest';
import type { ApiCaller, CallOptions } from '../src/core/client';
import type { HttpMethod } from '../src/core/http';
import { fetchTagTree, findTag, flattenTags, listTags, listTagsWithFallback } from '../src/core/tags';

function stubCaller(response: unknown, timezone?: string): { caller: ApiCaller; calls: CallOptions[] } {
  const calls: CallOptions[] = [];
  return {
    calls,
    caller: {
      baseV1: 'https://flomoapp.com/api/v1',
      baseV2: 'https://flomoapp.com/api/v2',
      timezone,
      async call<T>(_method: HttpMethod, _path: string, options: CallOptions = {}): Promise<T> {
        calls.push(options);
        return response as T;
      },
    },
  };
}

describe('flattenTags', () => {
  it('解析 /tag/tree 的 { tag_tree } 包裹结构', () => {
    const tree = {
      tag_tree: [
        { name: '读书', memo_count: 3, children: [{ name: '读书/小说', memo_count: 1 }] },
        { name: '工作', memo_count: 2 },
      ],
      updated_at: '2026-09-24 14:00:00',
    };
    expect(flattenTags(tree)).toEqual([
      { name: '读书', depth: 0, memoCount: 3 },
      { name: '读书/小说', depth: 1, memoCount: 1 },
      { name: '工作', depth: 0, memoCount: 2 },
    ]);
  });

  it('兼容纯数组与 tag 字段名', () => {
    expect(flattenTags([{ tag: 'a', count: 1 }])).toEqual([{ name: 'a', depth: 0, memoCount: 1 }]);
  });

  it('空树返回空数组', () => {
    expect(flattenTags({ tag_tree: [], updated_at: null })).toEqual([]);
    expect(flattenTags(null)).toEqual([]);
  });
});

describe('标签接口', () => {
  it('listTags 带上 tz 参数', async () => {
    const { caller, calls } = stubCaller({ tag_tree: [{ name: 'a' }] }, '8:0');
    const tags = await listTags(caller);
    expect(tags.map((tag) => tag.name)).toEqual(['a']);
    expect(calls[0]!.params).toEqual({ tz: '8:0' });
  });

  it('findTag 忽略 # 前缀且大小写不敏感', async () => {
    const { caller } = stubCaller({ tag_tree: [{ name: 'Flomo/Test' }] }, '8:0');
    expect(await findTag(caller, '#flomo/test')).toMatchObject({ name: 'Flomo/Test' });
    expect(await findTag(caller, '缺失')).toBeNull();
  });

  it('fetchTagTree 返回原始结构', async () => {
    const raw = { tag_tree: [], updated_at: null };
    const { caller } = stubCaller(raw, '8:0');
    expect(await fetchTagTree(caller)).toEqual(raw);
  });
});

describe('listTagsWithFallback', () => {
  function routingCaller(serverTree: unknown, memos: unknown[]): ApiCaller {
    return {
      baseV1: 'https://flomoapp.com/api/v1',
      baseV2: 'https://flomoapp.com/api/v2',
      timezone: '8:0',
      async call<T>(_method: HttpMethod, requestPath: string): Promise<T> {
        if (requestPath === '/tag/tree') return serverTree as T;
        if (requestPath === '/memo/updated/') return memos as T;
        throw new Error(`unexpected path: ${requestPath}`);
      },
    };
  }

  it('服务端标签表非空时直接用服务端结果', async () => {
    const caller = routingCaller({ tag_tree: [{ name: '读书', memo_count: 2 }] }, []);
    const result = await listTagsWithFallback(caller);
    expect(result.source).toBe('tag-tree');
    expect(result.tags.map((tag) => tag.name)).toEqual(['读书']);
  });

  it('服务端标签表为空时按笔记内容统计', async () => {
    const caller = routingCaller({ tag_tree: [], updated_at: null }, [
      { slug: 'a', content: 'x #读书 #读书/小说' },
      { slug: 'b', content: 'y #读书' },
    ]);
    const result = await listTagsWithFallback(caller);
    expect(result.source).toBe('memos');
    expect(result.tags).toEqual([
      { name: '读书', depth: 0, memoCount: 2 },
      { name: '读书/小说', depth: 1, memoCount: 1 },
    ]);
  });
});
