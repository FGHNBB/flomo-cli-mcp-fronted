import type { z } from 'zod';
import type { ToolContext } from '../context.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}
