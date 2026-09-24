import {
  contentToPlainText,
  effectiveTags,
  memoContent,
  memoCreatedAt,
  memoSlug,
  memoUpdatedAt,
  type FlomoMemo,
} from './core/index.js';

/** 对外输出的笔记结构（与 flomo-cli 的 NoteOutput 保持一致）。 */
export interface NoteOutput {
  id: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  content: string;
  source?: string;
}

/** MCP 侧只返回去壳后的正文（不提供 --raw，保持工具契约单一）。 */
export function toNoteOutput(memo: FlomoMemo): NoteOutput {
  const note: NoteOutput = {
    id: memoSlug(memo),
    created_at: memoCreatedAt(memo),
    updated_at: memoUpdatedAt(memo),
    tags: effectiveTags(memo),
    content: contentToPlainText(memoContent(memo)),
  };
  const source = memo.source;
  if (typeof source === 'string' && source.length > 0) note.source = source;
  return note;
}
