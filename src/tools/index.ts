import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runTool, type ToolDeps } from '../context.js';
import { getTool, healthTool, listTool, searchTool, tagsTool } from './read.js';
import { appendTool, createTool, deleteTool, replaceTool } from './write.js';
import type { ToolDef } from './types.js';

export const TOOLS: ToolDef[] = [
  listTool,
  getTool,
  searchTool,
  createTool,
  appendTool,
  replaceTool,
  deleteTool,
  tagsTool,
  healthTool,
];

/** 供 --list-tools 与文档使用的工具清单。 */
export function toolCatalog(): Array<{
  name: string;
  title: string;
  description: string;
  parameters: string[];
  annotations: Record<string, unknown>;
}> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    parameters: Object.keys(tool.inputSchema),
    annotations: tool.annotations as Record<string, unknown>,
  }));
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, any>) => runTool(tool.name, deps, (ctx) => tool.run(args ?? {}, ctx)),
    );
  }
}

export { healthTool };
