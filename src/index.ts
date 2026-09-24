#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveAuth, resolveDataDir } from './core/index.js';
import { runTool, type ToolDeps } from './context.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { healthTool, toolCatalog } from './tools/index.js';

const argv = process.argv.slice(2);
const debugEnabled = process.env.FLOMO_MCP_DEBUG === '1';

/** stdout 属于 MCP 协议，日志一律走 stderr。 */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function debug(message: string): void {
  if (debugEnabled) log(message);
}

function readDataDirArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--data-dir') return args[index + 1];
    if (arg.startsWith('--data-dir=')) return arg.slice('--data-dir='.length);
  }
  return undefined;
}

const dataDir = resolveDataDir(readDataDirArg(argv));
const deps: ToolDeps = { dataDir, onWarn: (message) => log(`警告：${message}`) };

if (argv.includes('--list-tools')) {
  // 非服务器模式，stdout 空闲，可以直接输出清单
  process.stdout.write(
    `${JSON.stringify(
      { ok: true, server: SERVER_NAME, version: SERVER_VERSION, tools: toolCatalog() },
      null,
      2,
    )}\n`,
  );
} else if (argv.includes('--self-test')) {
  const result = await runTool('flomo_health', deps, (ctx) => healthTool.run({}, ctx));
  process.stdout.write(`${result.content[0]!.text}\n`);
  process.exitCode = result.isError === true ? 1 : 0;
} else {
  const auth = resolveAuth(dataDir);
  if (auth) {
    debug(`凭据来源：${auth.source}${auth.readOnly ? '（只读）' : ''}`);
  } else {
    log(
      `警告：未找到凭据（配置目录 ${dataDir}）。` +
        '请注入 FLOMO_AUTH_JSON / FLOMO_AUTH_FILE / FLOMO_TOKEN，或先执行 flomo setup；' +
        '服务器仍会启动，可调用 flomo_health 工具查看详情。',
    );
  }

  const server = buildServer({ dataDir, onWarn: (message) => log(`警告：${message}`) });
  await server.connect(new StdioServerTransport());
  debug(`已通过 stdio 就绪（v${SERVER_VERSION}），数据目录：${dataDir}`);
}
