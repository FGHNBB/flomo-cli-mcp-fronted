import type { ApiCaller } from './client.js';
import { FlomoError } from './errors.js';
import { localTzOffset } from './tz.js';

export type FlomoMemo = Record<string, unknown>;

export interface ListMemosOptions {
  tag?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  tz?: string | undefined;
  /** 同步游标：只取该时间之后更新的笔记（首次全量传 0，与网页端一致） */
  latestUpdatedAt?: string | number | undefined;
  latestSlug?: string | undefined;
  pageSize?: number | undefined;
  maxPages?: number | undefined;
  /** 是否保留已删除的墓碑记录（默认过滤掉，与网页端展示一致） */
  includeDeleted?: boolean | undefined;
  /** 每页返回后的进度回调，供 CLI --visible 使用 */
  onProgress?: ((info: { page: number; fetched: number; target?: number }) => void) | undefined;
}

export interface MemoWriteOptions {
  apiVersion?: 'v1' | 'v2';
}

/** 兼容 data 为数组或包在 memos/items 里的多种返回形态。 */
export function normalizeMemoList(data: unknown): FlomoMemo[] {
  if (Array.isArray(data)) return data as FlomoMemo[];
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['memos', 'data', 'list', 'items', 'results']) {
      const value = record[key];
      if (Array.isArray(value)) return value as FlomoMemo[];
    }
  }
  return [];
}

export function memoContent(memo: FlomoMemo): string {
  const content = memo.content;
  return typeof content === 'string' ? content : '';
}

/** 网页端编辑器保存的内容可能是 HTML（实测形如 <p>…</p>），而 API 也接受纯文本。 */
export function isHtmlContent(content: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(content);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface PlainTextOptions {
  /** 链接是否保留 URL（默认保留，避免静默丢信息） */
  keepLinks?: boolean;
  /** 内联图片是否保留 [图片] 标记（默认保留） */
  keepImageMarkers?: boolean;
}

function decodeHtmlEntities(text: string): string {
  const fromCodePoint = (raw: string, radix: number): string => {
    const code = Number.parseInt(raw, radix);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  };

  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, raw: string) => fromCodePoint(raw, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, raw: string) => fromCodePoint(raw, 16))
    .replace(/&amp;/gi, '&');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 去壳：剥掉 HTML 结构，只留下笔记正文。
 * - 块级标签转为换行，`<br>` 转为换行，列表项转为 `- `
 * - 链接保留文本并附上 URL（可用 keepLinks: false 丢弃）
 * - 图片转成 `[图片]` 标记，避免静默丢失
 * - HTML 实体（含数字实体）还原成字符
 * 非 HTML 内容原样返回（仅做空白规整）。
 */
export function contentToPlainText(content: string, options: PlainTextOptions = {}): string {
  if (!content) return '';
  if (!isHtmlContent(content)) return normalizeWhitespace(content);

  const keepLinks = options.keepLinks ?? true;
  const keepImageMarkers = options.keepImageMarkers ?? true;

  let text = content;

  text = text.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      if (!label) return href;
      if (!keepLinks || label === href || label.includes(href)) return label;
      return `${label} (${href})`;
    },
  );

  text = text.replace(/<img\b[^>]*>/gi, (tag: string) => {
    if (!keepImageMarkers) return '';
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1]?.trim();
    return alt ? `[图片：${alt}]` : '[图片]';
  });

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article|figure|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');

  return normalizeWhitespace(decodeHtmlEntities(text));
}

/** 给笔记对象附加去壳后的 `text` 字段（保留原始 `content`）。 */
export function withPlainText<T extends FlomoMemo>(memo: T, options: PlainTextOptions = {}): T & { text: string } {
  return { ...memo, text: contentToPlainText(memoContent(memo), options) };
}

/**
 * 追加内容：纯文本笔记直接换行追加；HTML 笔记包装成新的 <p>，
 * 避免把段落文本挤进已有段落里。
 */
export function appendToContent(existing: string, addition: string): string {
  if (!existing) return addition;
  if (isHtmlContent(existing)) {
    return `${existing}<p>${escapeHtml(addition).replace(/\n/g, '<br>')}</p>`;
  }
  return `${existing}\n${addition}`;
}

export function memoTags(memo: FlomoMemo): string[] {
  const raw = memo.tags;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return typeof record.name === 'string' ? record.name : '';
        }
        return '';
      })
      .filter((name) => name.length > 0);
  }
  return [];
}

function extractTagsFromContent(content: string): string[] {
  return Array.from(new Set(Array.from(content.matchAll(/#([^\s#]+)/g)).map((m) => m[1] ?? ''))).filter(
    (name) => name.length > 0,
  );
}

export function effectiveTags(memo: FlomoMemo): string[] {
  const declared = memoTags(memo);
  return declared.length > 0 ? declared : extractTagsFromContent(memoContent(memo));
}

export function memoSlug(memo: FlomoMemo): string {
  const slug = memo.slug;
  return typeof slug === 'string' ? slug : '';
}

/** flomo 采用软删除：删除后仍以墓碑记录出现在同步接口里，需要本地过滤。 */
export function isDeletedMemo(memo: FlomoMemo): boolean {
  return Boolean(memo.deleted_at || memo.deleted_at_long);
}

export function memoCreatedAt(memo: FlomoMemo): string {
  for (const key of ['created_at', 'createdAt', 'created_at_long']) {
    const value = memo[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
  }
  return '';
}

export function memoUpdatedAt(memo: FlomoMemo): string {
  for (const key of ['updated_at', 'updatedAt', 'updated_at_long']) {
    const value = memo[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
  }
  return '';
}

function createdKey(memo: FlomoMemo): number {
  const raw = memo.created_at ?? memo.updated_at;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw.replace(' ', 'T'));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** 按创建时间倒序（最新在前），与网页端列表的展示顺序一致。 */
export function sortByCreatedAtDesc(memos: FlomoMemo[]): FlomoMemo[] {
  return [...memos].sort((a, b) => createdKey(b) - createdKey(a));
}

function tagMatches(tags: string[], wanted: string): boolean {
  const needle = wanted.replace(/^#/, '');
  return tags.some((tag) => tag === needle || tag.startsWith(`${needle}/`));
}

export async function listMemos(
  client: ApiCaller,
  options: ListMemosOptions = {},
): Promise<FlomoMemo[]> {
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 500;
  const offset = options.offset ?? 0;
  const tz = options.tz ?? client.timezone ?? localTzOffset();
  const target = options.limit === undefined ? undefined : offset + options.limit;

  const collected: FlomoMemo[] = [];
  let cursor: unknown = options.latestUpdatedAt ?? 0;
  let cursorSlug = options.latestSlug;

  for (let page = 0; page < maxPages; page += 1) {
    const params: Record<string, unknown> = { limit: pageSize, latest_updated_at: cursor, tz };
    if (cursorSlug) params.latest_slug = cursorSlug;

    const batch = normalizeMemoList(await client.call<unknown>('GET', '/memo/updated/', { params }));
    collected.push(...batch);
    options.onProgress?.({
      page: page + 1,
      fetched: collected.length,
      ...(target !== undefined ? { target } : {}),
    });
    if (batch.length < pageSize) break;

    const last = batch[batch.length - 1];
    if (!last) break;
    const nextCursor = last.updated_at ?? last.created_at;
    if (nextCursor === undefined || nextCursor === cursor) break;
    cursor = nextCursor;
    const lastSlug = memoSlug(last);
    cursorSlug = lastSlug || undefined;

    if (target !== undefined && collected.length >= target) break;
  }

  const visible = options.includeDeleted ? collected : collected.filter((memo) => !isDeletedMemo(memo));
  const filtered = options.tag
    ? visible.filter((memo) => tagMatches(effectiveTags(memo), options.tag!))
    : visible;
  const sorted = sortByCreatedAtDesc(filtered);
  if (options.limit === undefined && offset === 0) return sorted;
  return sorted.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
}

export async function getMemo(client: ApiCaller, slugOrId: string): Promise<FlomoMemo> {
  try {
    const data = await client.call<unknown>('GET', `/memo/${encodeURIComponent(slugOrId)}`);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as FlomoMemo;
    throw new FlomoError('PARSE', `笔记 ${slugOrId} 返回了非预期结构`);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new FlomoError('API', `笔记 ${slugOrId} 不存在或已被删除（服务端 code -1）`, {
        cause: error,
        details: { code: -1 },
      });
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof FlomoError)) return false;
  const details = error.details as { code?: unknown } | undefined;
  return details?.code === -1;
}

export async function createMemo(
  client: ApiCaller,
  content: string,
  options: MemoWriteOptions = {},
): Promise<FlomoMemo> {
  const apiVersion = options.apiVersion ?? 'v2';
  const data =
    apiVersion === 'v2'
      ? await client.call<unknown>('POST', '/memo', { baseUrl: client.baseV2, body: { content } })
      : await client.call<unknown>('PUT', '/memo', { body: { content } });
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as FlomoMemo) : { content };
}

export async function updateMemo(
  client: ApiCaller,
  slugOrId: string,
  content: string,
  options: MemoWriteOptions = {},
): Promise<FlomoMemo> {
  const apiVersion = options.apiVersion ?? 'v2';
  const path = `/memo/${encodeURIComponent(slugOrId)}`;
  const data =
    apiVersion === 'v2'
      ? await client.call<unknown>('PUT', path, { baseUrl: client.baseV2, body: { content } })
      : await client.call<unknown>('PUT', path, { body: { content } });
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as FlomoMemo) : { content };
}

export async function deleteMemo(
  client: ApiCaller,
  slugOrId: string,
  options: MemoWriteOptions = {},
): Promise<unknown> {
  const apiVersion = options.apiVersion ?? 'v2';
  const path = `/memo/${encodeURIComponent(slugOrId)}`;
  return apiVersion === 'v2'
    ? client.call<unknown>('DELETE', path, { baseUrl: client.baseV2 })
    : client.call<unknown>('DELETE', path);
}

export async function batchDeleteMemos(
  client: ApiCaller,
  slugs: string[],
  options: MemoWriteOptions = {},
): Promise<unknown> {
  const apiVersion = options.apiVersion ?? 'v2';
  const path = '/memo/batch-delete';
  return apiVersion === 'v2'
    ? client.call<unknown>('DELETE', path, { baseUrl: client.baseV2, body: { memo_slugs: slugs }, useBody: true })
    : client.call<unknown>('DELETE', path, { body: { memo_slugs: slugs }, useBody: true });
}

export interface SyncMemosOptions {
  limit?: number | undefined;
  latestUpdatedAt?: string | undefined;
  latestSlug?: string | undefined;
  tz?: string | undefined;
}

export async function syncUpdatedMemos(
  client: ApiCaller,
  options: SyncMemosOptions = {},
): Promise<FlomoMemo[]> {
  const params: Record<string, unknown> = {};
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.latestUpdatedAt) params.latest_updated_at = options.latestUpdatedAt;
  if (options.latestSlug) params.latest_slug = options.latestSlug;
  const tz = options.tz ?? client.timezone ?? localTzOffset();
  if (tz) params.tz = tz;

  const data = await client.call<unknown>('GET', '/memo/updated/', { params });
  return normalizeMemoList(data);
}

export interface SearchMemosOptions {
  tag?: string | undefined;
  limit?: number | undefined;
  tz?: string | undefined;
  onProgress?: ((info: { page: number; fetched: number; target?: number }) => void) | undefined;
}

/**
 * 关键词搜索：flomo 服务端没有搜索接口（网页端用本地 FlexSearch 索引），
 * 因此按页拉取后在前端过滤。limit 同时决定扫描范围，越大越慢但越全。
 */
export async function searchMemosLocal(
  client: ApiCaller,
  keyword: string,
  options: SearchMemosOptions = {},
): Promise<FlomoMemo[]> {
  const memos = await listMemos(client, {
    tag: options.tag,
    limit: options.limit ?? 200,
    offset: 0,
    tz: options.tz,
    onProgress: options.onProgress,
  });
  const needle = keyword.trim().toLowerCase();
  if (!needle) return memos;
  return memos.filter((memo) => contentToPlainText(memoContent(memo)).toLowerCase().includes(needle));
}
