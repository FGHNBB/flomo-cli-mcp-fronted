import { z } from 'zod';
import {
  appendToContent,
  batchDeleteMemos,
  contentToPlainText,
  createMemo,
  deleteMemo,
  FlomoError,
  getMemo,
  memoContent,
  memoSlug,
  toFlomoError,
  updateMemo,
} from '../core/index.js';
import { toNoteOutput } from '../notes.js';
import { shapeNote } from '../truncate.js';
import { assertIdsCap, MAX_IDS } from './read.js';
import type { ToolDef } from './types.js';

/** 写入后回读校验：发送内容与回读内容都去壳后比对，不一致直接报错。 */
function assertVerified(input: {
  sent: string;
  stored: string;
  id: string;
  action: string;
}): void {
  const sent = contentToPlainText(input.sent);
  const stored = contentToPlainText(input.stored);
  if (sent === stored) return;
  throw new FlomoError(
    'API',
    `${input.action} 后回读校验不一致（笔记 ${input.id}）：内容可能被服务端改写，请人工确认`,
    {
      details: {
        id: input.id,
        action: input.action,
        expected: sent.slice(0, 200),
        actual: stored.slice(0, 200),
      },
    },
  );
}

function requireContent(value: unknown, tool: string): string {
  const content = typeof value === 'string' ? value : '';
  if (content.trim().length === 0) throw new FlomoError('USAGE', `${tool} 的 content 不能为空`);
  return content;
}

function requireId(value: unknown, tool: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0) throw new FlomoError('USAGE', `${tool} 需要有效的笔记 id`);
  return id;
}

export const createTool: ToolDef = {
  name: 'flomo_create',
  title: '新建笔记',
  description:
    '新建一条笔记（正文里的 #标签 会被服务端识别为标签）。写入后会重新读取一次做回读校验，返回 verified 与笔记 ID。',
  inputSchema: {
    content: z.string().min(1).max(20000).describe('笔记正文，可包含 #标签'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const content = requireContent(args.content, 'flomo_create');
    const created = await createMemo(ctx.client, content);
    const id = memoSlug(created);
    const reread = id.length > 0 ? await getMemo(ctx.client, id) : created;
    assertVerified({ sent: content, stored: memoContent(reread), id: id || '(未返回 ID)', action: 'create' });
    return { action: 'create', verified: true, note: shapeNote(toNoteOutput(reread)) };
  },
};

export const appendTool: ToolDef = {
  name: 'flomo_append',
  title: '在笔记末尾追加内容',
  description:
    '把内容追加到指定笔记末尾（不会覆盖原有内容）。写入后会重新读取一次做回读校验，返回 verified。',
  inputSchema: {
    id: z.string().min(1).describe('笔记 ID'),
    content: z.string().min(1).max(20000).describe('要追加的内容'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const id = requireId(args.id, 'flomo_append');
    const content = requireContent(args.content, 'flomo_append');
    const current = await getMemo(ctx.client, id);
    const next = appendToContent(memoContent(current), content);
    await updateMemo(ctx.client, id, next);
    const reread = await getMemo(ctx.client, id);
    assertVerified({ sent: next, stored: memoContent(reread), id, action: 'append' });
    return { action: 'append', verified: true, id, note: shapeNote(toNoteOutput(reread)) };
  },
};

export const replaceTool: ToolDef = {
  name: 'flomo_replace',
  title: '整体替换笔记内容',
  description:
    '用给定内容**整体覆盖**指定笔记（原有内容会丢失，属破坏性操作）。写入后会重新读取一次做回读校验，返回 verified。',
  inputSchema: {
    id: z.string().min(1).describe('笔记 ID'),
    content: z.string().min(1).max(20000).describe('替换后的完整正文'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const id = requireId(args.id, 'flomo_replace');
    const content = requireContent(args.content, 'flomo_replace');
    await updateMemo(ctx.client, id, content);
    const reread = await getMemo(ctx.client, id);
    assertVerified({ sent: content, stored: memoContent(reread), id, action: 'replace' });
    return { action: 'replace', verified: true, id, note: shapeNote(toNoteOutput(reread)) };
  },
};

export const deleteTool: ToolDef = {
  name: 'flomo_delete',
  title: '删除笔记（不可撤销）',
  description:
    '删除 1–20 条笔记。flomo 采用软删除：删除后笔记不会再出现在列表里，但服务端以"墓碑"形式保留记录。' +
    '删除后会逐条确认不可再读取，未生效的 ID 会报错。',
  inputSchema: {
    ids: z.array(z.string().min(1)).min(1).max(MAX_IDS).describe('要删除的笔记 ID（最多 20 个）'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const ids = Array.isArray(args.ids) ? args.ids.map((item: unknown) => String(item).trim()).filter(Boolean) : [];
    assertIdsCap(ids, 'flomo_delete');

    if (ids.length === 1) await deleteMemo(ctx.client, ids[0]!);
    else await batchDeleteMemos(ctx.client, ids);

    // 逐条确认：能被读出来说明没删掉；只有"不存在（code -1）"才算删除成功
    const stillVisible: string[] = [];
    for (const id of ids) {
      try {
        await getMemo(ctx.client, id);
        stillVisible.push(id);
      } catch (error) {
        const flomoError = toFlomoError(error);
        const details = flomoError.details as { code?: unknown } | undefined;
        if (details?.code !== -1) throw flomoError;
      }
    }

    if (stillVisible.length > 0) {
      throw new FlomoError('API', `删除后有 ${stillVisible.length} 条笔记仍可读取`, {
        details: { stillVisible },
      });
    }

    return { deleted: ids, count: ids.length, stillVisible: [] };
  },
};
