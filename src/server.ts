import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './context.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'flomo-cli-mcp-fronted';
export const SERVER_VERSION = '0.1.0';

export interface BuildServerOptions {
  dataDir?: string;
  onWarn?: (message: string) => void;
}

export function buildServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const deps: ToolDeps = {
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    onWarn: options.onWarn ?? (() => {}),
  };
  registerTools(server, deps);
  return server;
}
