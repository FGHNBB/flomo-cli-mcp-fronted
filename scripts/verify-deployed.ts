/**
 * 部署校验：从 Codex 配置里读出 [mcp_servers.flomo] 的真实取值，
 * 按配置原样拉起 MCP 服务器，然后通过 MCP 读取笔记库。
 *
 *   npm run verify:deployed
 *
 * 之所以要"从配置里读"而不是自己拼命令，是为了验证真正会被 Codex 使用的那份配置。
 * 可用 CODEX_CONFIG 指定别的配置文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const configPath = process.env.CODEX_CONFIG?.trim() || path.join(os.homedir(), '.codex', 'config.toml');

if (!fs.existsSync(configPath)) {
  console.error(`找不到 Codex 配置文件：${configPath}`);
  process.exit(2);
}

interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 极简 TOML 读取：只解析 [mcp_servers.flomo] 与其 .env 子表。 */
function readFlomoEntry(text: string): McpEntry {
  const entry: McpEntry = { command: '', args: [], env: {} };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (section === 'mcp_servers.flomo') {
      if (key === 'command') entry.command = unquote(value);
      if (key === 'args') {
        entry.args = value
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((item) => unquote(item))
          .filter((item) => item.length > 0);
      }
    }
    if (section === 'mcp_servers.flomo.env') entry.env[key] = unquote(value);
  }
  return entry;
}

const entry = readFlomoEntry(fs.readFileSync(configPath, 'utf8'));
console.log(`配置文件：${configPath}`);
console.log(`command  ：${entry.command}`);
console.log(`args     ：${entry.args.join(' ') || '(空)'}`);
console.log(`env      ：${Object.entries(entry.env).map(([key, value]) => `${key}=${value}`).join(' ') || '(空)'}`);

if (!entry.command || entry.args.length === 0) {
  console.error('配置里没有找到 [mcp_servers.flomo] 的 command/args，无法校验');
  process.exit(2);
}
if (!fs.existsSync(entry.args[0]!)) {
  console.error(`配置里的入口文件不存在：${entry.args[0]}（需要先 npm run build）`);
  process.exit(2);
}

const childEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') childEnv[key] = value;
}

const transport = new StdioClientTransport({
  command: entry.command,
  args: entry.args,
  env: { ...childEnv, ...entry.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'flomo-deployed-check', version: '0.1.0' });

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const raw = await client.callTool({ name, arguments: args });
  const text = (raw.content ?? [])
    .filter((item: any) => item.type === 'text')
    .map((item: any) => String(item.text))
    .join('\n');
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (raw.isError === true) {
    console.error(`✖ ${name} 失败：${JSON.stringify(payload?.error ?? payload)}`);
  }
  return payload;
}

let exitCode = 0;
try {
  await client.connect(transport);
  console.log('\n===== 通过 MCP 读取笔记库 =====');

  const tools = await client.listTools();
  console.log(`工具数：${tools.tools.length}`);

  const health = await call('flomo_health');
  const info = health?.result ?? {};
  console.log(
    `健康检查：authSource=${info.authSource} 账号=${info.account?.name ?? '?'} 笔记数=${info.memoCount} 标签数=${info.tagCount} tz=${info.tz}`,
  );

  const list = await call('flomo_list', { limit: 5 });
  const notes = list?.result?.notes ?? [];
  console.log(`\n最近 ${notes.length} 条笔记：`);
  for (const note of notes) {
    const preview = String(note.content).replace(/\s+/g, ' ').slice(0, 70);
    console.log(
      `  • ${note.id}  ${note.created_at}${note.tags.length > 0 ? `  #${note.tags.join(' #')}` : ''}`,
    );
    console.log(`    ${preview}${note.truncated ? ' …' : ''}`);
  }

  if (notes.length > 0) {
    const detail = await call('flomo_get', { ids: [notes[0].id] });
    const got = detail?.result?.notes?.[0];
    console.log(`\n按 ID 取单条（${notes[0].id}）：${got ? `成功，正文 ${got.content_length} 字` : '失败'}`);
  }

  const search = await call('flomo_search', { queries: ['flomo'], maxResults: 3 });
  console.log(
    `关键词搜索 "flomo"：命中 ${search?.result?.count} 条（扫描 ${search?.result?.scanned} 条）`,
  );

  const tags = await call('flomo_tags');
  console.log(`标签：source=${tags?.result?.source} count=${tags?.result?.count}`);

  const failed = [health, list, search, tags].some((payload) => payload?.ok !== true);
  if (failed) exitCode = 1;
  console.log(`\n结论：${failed ? '存在调用失败，见上方输出' : '通过 MCP 访问笔记库正常'}`);
} catch (error) {
  console.error(`校验失败：${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

process.exitCode = exitCode;
