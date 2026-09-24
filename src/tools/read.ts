import { z } from 'zod';
import {
  contentToPlainText,
  errorMessage,
  FlomoError,
  getMemo,
  listMemos,
  listTagsWithFallback,
  memoContent,
} from '../core/index.js';
import { toNoteOutput } from '../notes.js';
import { clampInt, shapeNotes } from '../truncate.js';
import type { ToolDef } from './types.js';

export const MAX_IDS = 20;
export const MAX_QUERIES = 5;

export function assertIdsCap(ids: string[], tool: string): void {
  if (ids.length === 0) throw new FlomoError('USAGE', `${tool} 至少需要一个笔记 ID`);
  if (ids.length > MAX_IDS) {
    throw new FlomoError('USAGE', `${tool} 一次最多处理 ${MAX_IDS} 个 ID，收到 ${ids.length} 个`);
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

export const listTool: ToolDef = {
  name: 'flomo_list',
  title: '列出 flomo 笔记',
  description:
    '按创建时间倒序列出笔记（默认最近 20 条，最多 200）。正文默认去壳后截断到 800 字，需要全文时传 full:true。' +
    '可用 tag 过滤，标签匹配包含子标签（tag="读书" 也会匹配 "读书/小说"）。已删除的笔记不会出现。',
  inputSchema: {
    tag: z.string().min(1).optional().describe('只列出带该标签的笔记（不含 # 前缀）'),
    limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 20，最大 200'),
    full: z.boolean().optional().describe('是否返回完整正文（默认 false：截断到 800 字）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const limit = clampInt(args.limit, 1, 200, 20);
    const tag = typeof args.tag === 'string' && args.tag.length > 0 ? args.tag : undefined;
    const memos = await listMemos(ctx.client, { ...(tag ? { tag } : {}), limit });
    const notes = shapeNotes(memos.map(toNoteOutput), { full: args.full === true });
    return {
      tag: tag ?? null,
      count: notes.length,
      truncated: notes.some((note) => note.truncated),
      notes,
    };
  },
};

export const getTool: ToolDef = {
  name: 'flomo_get',
  title: '按 ID 获取笔记内容',
  description:
    '按笔记 ID 精确获取正文（可一次取多条，最多 20 条）。正文默认去壳后截断到 800 字，需要全文时传 full:true。' +
    '部分 ID 不存在时会记入 failures，全部失败则返回错误。',
  inputSchema: {
    ids: z.array(z.string().min(1)).min(1).max(MAX_IDS).describe('笔记 ID 列表（最多 20 个）'),
    full: z.boolean().optional().describe('是否返回完整正文（默认 false：截断到 800 字）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const ids = asStringArray(args.ids);
    assertIdsCap(ids, 'flomo_get');

    const notes: ReturnType<typeof toNoteOutput>[] = [];
    const failures: { id: string; message: string }[] = [];
    for (const id of ids) {
      try {
        notes.push(toNoteOutput(await getMemo(ctx.client, id)));
      } catch (error) {
        failures.push({ id, message: errorMessage(error) });
      }
    }

    if (notes.length === 0 && failures.length > 0) {
      throw new FlomoError('API', `全部 ${failures.length} 个 ID 都读取失败：${failures[0]!.message}`, {
        details: { failures },
      });
    }

    return {
      requested: ids,
      count: notes.length,
      failures,
      notes: shapeNotes(notes, { full: args.full === true }),
    };
  },
};

export const searchTool: ToolDef = {
  name: 'flomo_search',
  title: '关键词搜索笔记',
  description:
    '在笔记正文里做关键词匹配（1–5 个关键词，命中任意一个即算命中）。' +
    '服务端没有搜索接口，本工具会按页拉取笔记后在本地匹配：先扫 scanLimit 条（默认 200，最大 1000），再取前 maxResults 条（默认 20，最大 100）。' +
    '返回里的 scanned 表示实际扫描了多少条，便于判断是否需要扩大范围。',
  inputSchema: {
    queries: z.array(z.string().min(1)).min(1).max(MAX_QUERIES).describe('关键词列表（1–5 个，OR 关系）'),
    tag: z.string().min(1).optional().describe('只在该标签的笔记里检索'),
    scanLimit: z.number().int().min(1).max(1000).optional().describe('最多扫描多少条笔记，默认 200'),
    maxResults: z.number().int().min(1).max(100).optional().describe('最多返回多少条，默认 20'),
    full: z.boolean().optional().describe('是否返回完整正文（默认 false：截断到 800 字）'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const queries = asStringArray(args.queries);
    if (queries.length === 0) throw new FlomoError('USAGE', 'flomo_search 至少需要一个关键词');
    if (queries.length > MAX_QUERIES) {
      throw new FlomoError('USAGE', `flomo_search 最多 ${MAX_QUERIES} 个关键词，收到 ${queries.length} 个`);
    }

    const scanLimit = clampInt(args.scanLimit, 1, 1000, 200);
    const maxResults = clampInt(args.maxResults, 1, 100, 20);
    const tag = typeof args.tag === 'string' && args.tag.length > 0 ? args.tag : undefined;

    // 只扫描一次，多关键词在本地做 OR 匹配
    const memos = await listMemos(ctx.client, { ...(tag ? { tag } : {}), limit: scanLimit });
    const lowered = queries.map((query) => query.toLowerCase());
    const matched = memos
      .filter((memo) => {
        const text = contentToPlainText(memoContent(memo)).toLowerCase();
        return lowered.some((query) => text.includes(query));
      })
      .slice(0, maxResults);

    return {
      queries,
      tag: tag ?? null,
      scanned: memos.length,
      count: matched.length,
      notes: shapeNotes(matched.map(toNoteOutput), { full: args.full === true }),
    };
  },
};

export const tagsTool: ToolDef = {
  name: 'flomo_tags',
  title: '查询标签',
  description:
    '不传 name 时列出全部标签；传 name 时查询单个标签。' +
    '标签来源用 source 标明：tag-tree 表示服务端标签表，memos 表示服务端标签表为空、按笔记内容统计。',
  inputSchema: {
    name: z.string().min(1).optional().describe('标签名（可不带 # 前缀）；不传则列出全部'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const result = await listTagsWithFallback(ctx.client);
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name.length > 0) {
      const needle = name.replace(/^#/, '').toLowerCase();
      const found = result.tags.find((tag) => tag.name.toLowerCase() === needle) ?? null;
      return { source: result.source, name, found };
    }
    return { source: result.source, count: result.tags.length, tags: result.tags };
  },
};

export const healthTool: ToolDef = {
  name: 'flomo_health',
  title: '健康检查（凭据 / 账号 / 契约）',
  description:
    '检查凭据是否可用、当前凭据来源、账号信息、契约参数与数据规模。' +
    'agent 在开始工作前或遇到鉴权错误后调用它，即可知道问题出在哪里。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (_args, ctx) => {
    const me = await ctx.client.call<Record<string, unknown>>('GET', '/user/me');
    const memos = await listMemos(ctx.client, { limit: 1000 });
    const tags = await listTagsWithFallback(ctx.client);
    const contract = ctx.client.currentContract;

    return {
      authSource: ctx.auth.source,
      readOnly: ctx.auth.readOnly,
      account: me,
      contract: {
        sourceUrl: contract.sourceUrl,
        apiKey: contract.apiKey,
        appVersion: contract.appVersion,
        baseV1: contract.baseV1,
        baseV2: contract.baseV2,
        fetchedAt: contract.fetchedAt,
      },
      memoCount: memos.length,
      memoCountCapped: memos.length >= 1000,
      tagCount: tags.tags.length,
      tagSource: tags.source,
      tz: ctx.client.timezone,
      dataDir: ctx.dataDir,
      warnings: ctx.warnings,
    };
  },
};
