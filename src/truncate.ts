import type { NoteOutput } from './notes.js';

/** 单篇正文默认截断长度（字符）。 */
export const DEFAULT_CONTENT_LIMIT = 800;

export interface ShapedNote extends NoteOutput {
  truncated: boolean;
  content_length: number;
}

/** 把数值参数夹到 [min, max]；非法值回落到 fallback。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const int = Math.trunc(number);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

/**
 * 按 full 开关决定是否截断正文。
 * 默认截断，并在结果里用 truncated / content_length 明示，
 * 让 agent 知道"还有更多内容，需要 full=true 再取一次"。
 */
export function shapeNote(
  note: NoteOutput,
  options: { full?: boolean; limit?: number } = {},
): ShapedNote {
  const full = options.full === true;
  const limit = clampInt(options.limit, 1, 100_000, DEFAULT_CONTENT_LIMIT);
  const contentLength = note.content.length;
  if (full || contentLength <= limit) {
    return { ...note, truncated: false, content_length: contentLength };
  }
  return {
    ...note,
    content: `${note.content.slice(0, limit)}…`,
    truncated: true,
    content_length: contentLength,
  };
}

export function shapeNotes(
  notes: NoteOutput[],
  options: { full?: boolean; limit?: number } = {},
): ShapedNote[] {
  return notes.map((note) => shapeNote(note, options));
}
