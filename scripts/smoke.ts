/**
 * 端到端冒烟：用真正的 MCP 客户端通过 stdio 拉起服务器，跑通全部工具的关键路径。
 * 需要凭据：优先用环境变量 FLOMO_AUTH_JSON，其次读取同级 flomo-cli 的 .flomo/auth.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dist', 'index.js');
const expectedTools = [
  'flomo_list',
  'flomo_get',
  'flomo_search',
  'flomo_create',
  'flomo_append',
  'flomo_replace',
  'flomo_delete',
  'flomo_tags',
  'flomo_health',
];

if (!fs.existsSync(entry)) {
  console.error(`找不到 ${entry}，请先执行 npm run build`);
  process.exit(2);
}

function loadCredentials(): string {
  const fromEnv = process.env.FLOMO_AUTH_JSON?.trim();
  if (fromEnv) return fromEnv;
  const sibling = path.join(root, '..', 'flomo-cli', '.flomo', 'auth.json');
  if (fs.existsSync(sibling)) return fs.readFileSync(sibling, 'utf8').trim();
  console.error('缺少凭据：请设置 FLOMO_AUTH_JSON，或确保同级 flomo-cli/.flomo/auth.json 存在');
  process.exit(2);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `：${detail}` : ''}`);
}

const cleanEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') cleanEnv[key] = value;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...cleanEnv, FLOMO_AUTH_JSON: loadCredentials() },
  stderr: 'inherit',
});
const client = new Client({ name: 'flomo-mcp-smoke', version: '0.1.0' });

async function call(name: string, args: Record<string, unknown>): Promise<{ payload: any; text: string; isError: boolean }> {
  const raw = await client.callTool({ name, arguments: args });
  const text = (raw.content ?? [])
    .filter((item: any) => item.type === 'text')
    .map((item: any) => String(item.text))
    .join('\n');
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { payload, text, isError: raw.isError === true };
}

const marker = `flomo-mcp smoke ${new Date().toISOString()}`;
let createdId: string | null = null;

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool: any) => tool.name).sort();
  const missing = expectedTools.filter((name) => !names.includes(name));
  check('tools/list 暴露 9 个工具', names.length === expectedTools.length && missing.length === 0,
    `实际 ${names.length} 个${missing.length > 0 ? `，缺少 ${missing.join(', ')}` : ''}`);

  const health = await call('flomo_health', {});
  check('flomo_health 返回正常', health.isError === false && health.payload?.result?.authSource !== undefined,
    `authSource=${health.payload?.result?.authSource} memoCount=${health.payload?.result?.memoCount}`);

  const list = await call('flomo_list', { limit: 3 });
  check('flomo_list 返回笔记数组', list.isError === false && Array.isArray(list.payload?.result?.notes),
    `count=${list.payload?.result?.count}`);

  const created = await call('flomo_create', { content: `${marker}\n第一行` });
  createdId = created.payload?.result?.note?.id ?? null;
  check('flomo_create 新建并回读校验', created.isError === false && created.payload?.result?.verified === true && !!createdId,
    `id=${createdId}`);

  if (!createdId) throw new Error('创建失败，后续步骤无法继续');

  const fetched = await call('flomo_get', { ids: [createdId] });
  check('flomo_get 取到刚建的笔记', fetched.isError === false && fetched.payload?.result?.count === 1);

  const appended = await call('flomo_append', { id: createdId, content: '追加一行' });
  check('flomo_append 追加并回读校验', appended.isError === false && appended.payload?.result?.verified === true,
    `内容长度=${appended.payload?.result?.note?.content_length}`);

  const replaced = await call('flomo_replace', { id: createdId, content: `${marker} 整体替换` });
  check('flomo_replace 整体替换并校验', replaced.isError === false && replaced.payload?.result?.verified === true);

  const searched = await call('flomo_search', { queries: ['flomo-mcp smoke', '不存在的关键词zzz'], maxResults: 5 });
  check('flomo_search 命中刚建的笔记', searched.isError === false && searched.payload?.result?.count >= 1,
    `scanned=${searched.payload?.result?.scanned} count=${searched.payload?.result?.count}`);

  const truncated = await call('flomo_get', { ids: [createdId], full: false });
  check('截断字段存在（truncated / content_length 都是数字或布尔）',
    typeof truncated.payload?.result?.notes?.[0]?.truncated === 'boolean' &&
      typeof truncated.payload?.result?.notes?.[0]?.content_length === 'number');

  const tags = await call('flomo_tags', {});
  check('flomo_tags 返回标签列表', tags.isError === false && tags.payload?.result?.source !== undefined,
    `source=${tags.payload?.result?.source}`);

  const removed = await call('flomo_delete', { ids: [createdId] });
  check('flomo_delete 删除并确认不可读', removed.isError === false && removed.payload?.result?.count === 1);
  createdId = null;

  const afterDelete = await call('flomo_list', { limit: 20 });
  const stillThere = (afterDelete.payload?.result?.notes ?? []).some((note: any) => note.id === removed.payload?.result?.deleted?.[0]);
  check('删除后列表里不再出现', stillThere === false);
} catch (error) {
  check('冒烟过程未抛异常', false, error instanceof Error ? error.message : String(error));
} finally {
  if (createdId) {
    console.log(`\n兜底清理：尝试删除 ${createdId}`);
    try {
      await call('flomo_delete', { ids: [createdId] });
      console.log('✔ 兜底删除成功');
    } catch (error) {
      console.log(`✖ 兜底删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await client.close().catch(() => {});
}

const failed = results.filter((item) => !item.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 项通过 ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
