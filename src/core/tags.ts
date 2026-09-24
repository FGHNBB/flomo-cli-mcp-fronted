import type { ApiCaller } from './client.js';
import { effectiveTags, listMemos } from './memos.js';

export interface FlatTag {
  name: string;
  depth: number;
  memoCount?: number;
}

export function flattenTags(tree: unknown, depth = 0): FlatTag[] {
  const out: FlatTag[] = [];
  const walk = (node: unknown, level: number): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, level);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const name =
      typeof record.name === 'string'
        ? record.name
        : typeof record.tag === 'string'
          ? record.tag
          : '';
    const count = record.memo_count ?? record.memoCount ?? record.count;

    if (name) {
      const tag: FlatTag = { name, depth: level };
      const numeric = typeof count === 'number' ? count : Number(count);
      if (!Number.isNaN(numeric)) tag.memoCount = numeric;
      out.push(tag);
    }

    // tag_tree 是 /tag/tree 的包裹键（实测返回 { tag_tree: [...], updated_at }）
    for (const key of ['tag_tree', 'children', 'tags', 'sub_tags', 'subTags']) {
      if (record[key] !== undefined) walk(record[key], name ? level + 1 : level);
    }
  };
  walk(tree, depth);
  return out;
}

export async function fetchTagTree(client: ApiCaller): Promise<unknown> {
  const params: Record<string, unknown> = {};
  if (client.timezone) params.tz = client.timezone;
  return client.call<unknown>('GET', '/tag/tree', { params });
}

export async function listTags(client: ApiCaller): Promise<FlatTag[]> {
  return flattenTags(await fetchTagTree(client));
}

export async function findTag(client: ApiCaller, name: string): Promise<FlatTag | null> {
  const needle = name.replace(/^#/, '').toLowerCase();
  const tags = await listTags(client);
  return tags.find((tag) => tag.name.toLowerCase() === needle) ?? null;
}

export interface TagListResult {
  source: 'tag-tree' | 'memos';
  tags: FlatTag[];
}

/**
 * 标签列表。
 * `/tag/tree` 返回的是服务端标签表，实测在账号标签表为空时（即使笔记里已经带了标签）
 * 也会返回空数组，因此这里提供回退：按笔记内容统计标签，保证结果始终可用。
 */
export async function listTagsWithFallback(
  client: ApiCaller,
  options: { memoLimit?: number } = {},
): Promise<TagListResult> {
  const serverTags = await listTags(client);
  if (serverTags.length > 0) return { source: 'tag-tree', tags: serverTags };

  const memos = await listMemos(client, { limit: options.memoLimit ?? 500 });
  const counts = new Map<string, number>();
  for (const memo of memos) {
    for (const tag of effectiveTags(memo)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const tags = [...counts.entries()]
    .map(([name, memoCount]) => ({ name, depth: name.split('/').length - 1, memoCount }))
    .sort((a, b) => b.memoCount - a.memoCount || a.name.localeCompare(b.name));

  return { source: 'memos', tags };
}

export async function renameTag(client: ApiCaller, oldTag: string, newTag: string): Promise<unknown> {
  return client.call<unknown>('POST', '/tag/rename', {
    body: { old_tag: oldTag.replace(/^#/, ''), new_tag: newTag.replace(/^#/, '') },
  });
}
