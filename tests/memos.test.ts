import { describe, expect, it } from 'vitest';
import type { ApiCaller, CallOptions } from '../src/core/client';
import {
  appendToContent,
  batchDeleteMemos,
  contentToPlainText,
  createMemo,
  deleteMemo,
  effectiveTags,
  getMemo,
  isDeletedMemo,
  listMemos,
  normalizeMemoList,
  searchMemosLocal,
  sortByCreatedAtDesc,
  updateMemo,
  withPlainText,
} from '../src/core/memos';
import { FlomoError } from '../src/core/errors';
import type { HttpMethod } from '../src/core/http';

interface Recorded {
  method: HttpMethod;
  path: string;
  options: CallOptions;
}

function stubCaller(response: (recorded: Recorded) => unknown): { caller: ApiCaller; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const caller: ApiCaller = {
    baseV1: 'https://flomoapp.com/api/v1',
    baseV2: 'https://flomoapp.com/api/v2',
    timezone: undefined,
    async call<T>(method: HttpMethod, requestPath: string, options: CallOptions = {}): Promise<T> {
      const recorded: Recorded = { method, path: requestPath, options };
      calls.push(recorded);
      return response(recorded) as T;
    },
  };
  return { caller, calls };
}

describe('normalizeMemoList', () => {
  it('兼容数组与包裹形态', () => {
    expect(normalizeMemoList([{ slug: 'a' }])).toHaveLength(1);
    expect(normalizeMemoList({ memos: [{ slug: 'a' }] })).toHaveLength(1);
    expect(normalizeMemoList({ data: [{ slug: 'a' }] })).toHaveLength(1);
    expect(normalizeMemoList({ unexpected: true })).toEqual([]);
    expect(normalizeMemoList(null)).toEqual([]);
  });
});

describe('effectiveTags', () => {
  it('优先使用 tags 字段', () => {
    expect(effectiveTags({ tags: ['读书', '笔记'] })).toEqual(['读书', '笔记']);
  });

  it('tags 缺失时从正文解析 #标签', () => {
    expect(effectiveTags({ content: '今天读完 #读书 很爽 #笔记' })).toEqual(['读书', '笔记']);
  });
});

describe('列表与详情', () => {
  it('listMemos 走 /memo/updated/ 并带上 latest_updated_at 与 tz', async () => {
    const { caller, calls } = stubCaller(() => [{ slug: 'a', created_at: '2026-09-24 10:00:00' }]);
    const memos = await listMemos(caller, { limit: 5, tz: '8:0' });
    expect(memos).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/memo/updated/' });
    expect(calls[0]!.options.params).toEqual({ limit: 200, latest_updated_at: 0, tz: '8:0' });
  });

  it('默认 tz 为本地偏移（小时:分钟）', async () => {
    const { caller, calls } = stubCaller(() => []);
    await listMemos(caller);
    expect(String(calls[0]!.options.params!.tz)).toMatch(/^-?\d+:\d+$/);
  });

  it('满页时用最后一条的 updated_at 继续翻页，达到目标条数即停止', async () => {
    const pages = [
      [
        { slug: 'a1', updated_at: '2026-09-24 10:00:00' },
        { slug: 'a2', updated_at: '2026-09-24 10:01:00' },
      ],
      [{ slug: 'b1', updated_at: '2026-09-24 10:02:00' }],
    ];
    let pageIndex = 0;
    const { caller, calls } = stubCaller(() => pages[pageIndex++] ?? []);

    const memos = await listMemos(caller, { limit: 3, pageSize: 2, tz: '8:0' });
    expect(memos).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.params).toMatchObject({
      limit: 2,
      latest_updated_at: '2026-09-24 10:01:00',
      latest_slug: 'a2',
    });
  });

  it('返回条数不足一页时停止翻页', async () => {
    const { caller, calls } = stubCaller(() => [{ slug: 'only' }]);
    await listMemos(caller, { limit: 50, pageSize: 2, tz: '8:0' });
    expect(calls).toHaveLength(1);
  });

  it('标签过滤在前端完成，且包含子标签', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'a', content: '读书笔记 #读书' },
      { slug: 'b', content: '小说 #读书/小说' },
      { slug: 'c', content: '无关 #其他' },
    ]);
    const memos = await listMemos(caller, { tag: '读书', tz: '8:0' });
    expect(memos.map((memo) => memo.slug)).toEqual(['a', 'b']);
  });

  it('结果按创建时间倒序排列', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'old', created_at: '2026-09-01 08:00:00' },
      { slug: 'new', created_at: '2026-09-24 08:00:00' },
    ]);
    const memos = await listMemos(caller, { limit: 10, tz: '8:0' });
    expect(memos.map((memo) => memo.slug)).toEqual(['new', 'old']);
  });

  it('默认过滤掉软删除的墓碑记录', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'alive', content: '还在' },
      { slug: 'gone', content: '已删', deleted_at: '2026-09-24 13:59:22' },
      { slug: 'gone2', content: '已删', deleted_at_long: '2026-09-24 13:59:22' },
    ]);
    const memos = await listMemos(caller, { limit: 10, tz: '8:0' });
    expect(memos.map((memo) => memo.slug)).toEqual(['alive']);
  });

  it('includeDeleted 可保留墓碑（用于同步对账）', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'alive' },
      { slug: 'gone', deleted_at: '2026-09-24 13:59:22' },
    ]);
    const memos = await listMemos(caller, { limit: 10, tz: '8:0', includeDeleted: true });
    expect(memos).toHaveLength(2);
  });

  it('isDeletedMemo 识别两种墓碑字段', () => {
    expect(isDeletedMemo({ deleted_at: 'x' })).toBe(true);
    expect(isDeletedMemo({ deleted_at_long: 'x' })).toBe(true);
    expect(isDeletedMemo({ deleted_at: null, deleted_at_long: null })).toBe(false);
  });

  it('getMemo 对 slug 做 URL 编码', async () => {
    const { caller, calls } = stubCaller(() => ({ slug: 'a b', content: 'x' }));
    await getMemo(caller, 'a b');
    expect(calls[0]!.path).toBe('/memo/a%20b');
  });

  it('getMemo 在服务端返回 code -1 时给出明确提示', async () => {
    const { caller } = stubCaller(() => {
      throw new FlomoError('API', 'not found', { details: { code: -1 } });
    });
    await expect(getMemo(caller, 'gone')).rejects.toMatchObject({
      kind: 'API',
      message: expect.stringContaining('已被删除'),
    });
  });

  it('contentToPlainText 把 HTML 笔记转成可读文本', () => {
    expect(contentToPlainText('<p>恭喜你</p><p>第二条&nbsp;内容</p>')).toBe('恭喜你\n第二条 内容');
    expect(contentToPlainText('纯文本 #标签')).toBe('纯文本 #标签');
    expect(contentToPlainText('')).toBe('');
  });

  it('去壳：块级标签、br、列表与分隔线', () => {
    expect(contentToPlainText('<div><p>一段</p><p>二段</p></div>')).toBe('一段\n二段');
    expect(contentToPlainText('第一行<br>第二行')).toBe('第一行\n第二行');
    expect(contentToPlainText('<ul><li>甲</li><li>乙</li></ul>')).toBe('- 甲\n- 乙');
    expect(contentToPlainText('<p>上</p><hr><p>下</p>')).toBe('上\n\n---\n\n下');
  });

  it('去壳：链接与图片', () => {
    expect(contentToPlainText('<p><a href="https://a.com">示例</a></p>')).toBe('示例 (https://a.com)');
    expect(contentToPlainText('<a href="https://a.com">https://a.com</a>')).toBe('https://a.com');
    expect(contentToPlainText('<a href="https://a.com">示例</a>', { keepLinks: false })).toBe('示例');
    expect(contentToPlainText('<p>图：<img src="x.png" alt="封面"></p>')).toBe('图：[图片：封面]');
    expect(contentToPlainText('<p>图：<img src="x.png"></p>', { keepImageMarkers: false })).toBe('图：');
  });

  it('去壳：HTML 实体与数字实体', () => {
    expect(contentToPlainText('<p>a &amp; b &lt;c&gt; &#39;d&#39; &#x27;e&#x27;</p>')).toBe("a & b <c> 'd' 'e'");
  });

  it('withPlainText 保留原始 content 并附加 text', () => {
    const memo = { slug: 's', content: '<p>正文</p>' };
    expect(withPlainText(memo)).toEqual({ slug: 's', content: '<p>正文</p>', text: '正文' });
    expect(memo).not.toHaveProperty('text');
  });

  it('appendToContent 对 HTML 笔记包装成新段落', () => {
    expect(appendToContent('<p>原文</p>', '追加')).toBe('<p>原文</p><p>追加</p>');
    expect(appendToContent('纯文本', '追加')).toBe('纯文本\n追加');
    expect(appendToContent('', '追加')).toBe('追加');
  });
});

describe('写入操作', () => {
  it('createMemo 默认走 v2 POST /memo', async () => {
    const { caller, calls } = stubCaller(() => ({ slug: 'new' }));
    await createMemo(caller, 'hello');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/memo' });
    expect(calls[0]!.options.baseUrl).toBe('https://flomoapp.com/api/v2');
    expect(calls[0]!.options.body).toEqual({ content: 'hello' });
  });

  it('createMemo 可切换 v1 PUT /memo', async () => {
    const { caller, calls } = stubCaller(() => ({}));
    await createMemo(caller, 'hello', { apiVersion: 'v1' });
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/memo' });
    expect(calls[0]!.options.baseUrl).toBeUndefined();
  });

  it('updateMemo 走 v2 PUT /memo/{slug}', async () => {
    const { caller, calls } = stubCaller(() => ({}));
    await updateMemo(caller, 'abc', 'next');
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/memo/abc' });
    expect(calls[0]!.options.baseUrl).toBe('https://flomoapp.com/api/v2');
  });

  it('deleteMemo 走 v2 DELETE', async () => {
    const { caller, calls } = stubCaller(() => null);
    await deleteMemo(caller, 'abc');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/memo/abc' });
    expect(calls[0]!.options.baseUrl).toBe('https://flomoapp.com/api/v2');
  });

  it('batchDeleteMemos 把 slug 列表放进 body', async () => {
    const { caller, calls } = stubCaller(() => null);
    await batchDeleteMemos(caller, ['a', 'b']);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/memo/batch-delete', options: { useBody: true } });
    expect(calls[0]!.options.body).toEqual({ memo_slugs: ['a', 'b'] });
  });

  it('batchDeleteMemos 可走 v1 基址', async () => {
    const { caller, calls } = stubCaller(() => null);
    await batchDeleteMemos(caller, ['a'], { apiVersion: 'v1' });
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/memo/batch-delete' });
    expect(calls[0]!.options.baseUrl).toBeUndefined();
  });
});

describe('本地搜索', () => {
  it('按正文关键字过滤并忽略大小写', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'a', content: 'Read Flomo Notes' },
      { slug: 'b', content: '无关内容' },
    ]);
    const found = await searchMemosLocal(caller, 'flomo');
    expect(found.map((memo) => memo.slug)).toEqual(['a']);
  });

  it('搜索时忽略 HTML 标记', async () => {
    const { caller } = stubCaller(() => [
      { slug: 'html', content: '<p>恭喜你，成功了</p>' },
      { slug: 'other', content: '无关' },
    ]);
    const found = await searchMemosLocal(caller, '恭喜你');
    expect(found.map((memo) => memo.slug)).toEqual(['html']);
  });

  it('关键字为空时返回全部扫描结果', async () => {
    const { caller } = stubCaller(() => [{ slug: 'a', content: 'x' }]);
    expect(await searchMemosLocal(caller, '  ')).toHaveLength(1);
  });
});

describe('sortByCreatedAtDesc', () => {
  it('数字时间戳与字符串时间都能排序', () => {
    const sorted = sortByCreatedAtDesc([
      { slug: 'a', created_at: 1_700_000_000 },
      { slug: 'b', created_at: '2026-09-24 08:00:00' },
    ]);
    expect(sorted.map((memo) => memo.slug)).toEqual(['b', 'a']);
  });
});
