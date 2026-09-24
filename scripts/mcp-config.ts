/**
 * 管理 Codex 配置里的 flomo MCP 服务器条目。
 *
 *   npm run mcp:deploy            # 写入 / 更新条目（幂等，可用 --dry-run 预览）
 *   npm run mcp:undeploy          # 撤销部署，移除条目（默认先备份）
 *
 * 选项：
 *   --dry-run                 只显示将要做的改动，不写文件
 *   --server <name>           服务器名，默认 flomo
 *   --config <path>           配置文件，默认 $CODEX_CONFIG 或 ~/.codex/config.toml
 *   --auth-file <path>        凭据文件，默认同级 flomo-cli/.flomo/auth.json
 *   --restore <path|latest>   用备份覆盖整个配置文件（会连带撤销其它改动，慎用）
 *   --list-backups            列出备份文件
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function readFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === `--${name}`) return args[index + 1] ?? '';
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const args = process.argv.slice(2);
const action = args[0] === 'add' || args[0] === 'remove' ? args[0] : undefined;
const dryRun = hasFlag('dry-run');
const serverName = readFlag('server')?.trim() || 'flomo';
const configPath = path.resolve(
  readFlag('config')?.trim() || process.env.CODEX_CONFIG?.trim() || path.join(os.homedir(), '.codex', 'config.toml'),
);
const entryPath = path.join(root, 'dist', 'index.js');
const authFilePath = path.resolve(
  readFlag('auth-file')?.trim() || path.join(root, '..', 'flomo-cli', '.flomo', 'auth.json'),
);

const headerMain = `[mcp_servers.${serverName}]`;
const headerEnv = `[mcp_servers.${serverName}.env]`;

function listBackups(): string[] {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 生成要写入的 TOML 片段（Windows 路径用 TOML 字面量字符串，无需转义）。 */
function renderBlock(): string {
  return [
    '',
    headerMain,
    `args = ['${entryPath}']`,
    `command = '${process.execPath}'`,
    'startup_timeout_sec = 60',
    '',
    headerEnv,
    `FLOMO_AUTH_FILE = '${authFilePath}'`,
    '',
  ].join('\n');
}

/** 移除指定 server 的两个 section；随后折叠多余空行、去掉文件末尾空行。 */
function stripBlock(text: string): { text: string; removed: number } {
  const lines = text.split(/\r?\n/);
  const drop = new Set<number>();
  let section: string | null = null;
  let removed = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line;
      if (section === headerMain || section === headerEnv) {
        drop.add(index);
        removed += 1;
      }
      continue;
    }
    if (section === headerMain || section === headerEnv) {
      if (line !== '') {
        drop.add(index);
        removed += 1;
      } else {
        drop.add(index); // section 内的空行
      }
    }
  }

  const collapsed: string[] = [];
  for (const line of lines.filter((_, index) => !drop.has(index))) {
    if (line.trim() === '' && (collapsed[collapsed.length - 1] ?? '').trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === '') collapsed.pop();
  return { text: `${collapsed.join('\n')}\n`, removed };
}

function countSections(text: string): number {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed === headerMain || trimmed === headerEnv;
  }).length;
}

function backup(): string | null {
  if (!fs.existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${configPath}.bak-${stamp}`;
  fs.copyFileSync(configPath, target);
  return target;
}

if (hasFlag('list-backups')) {
  const backups = listBackups();
  console.log(backups.length === 0 ? '（没有备份）' : backups.join('\n'));
  process.exit(0);
}

const restoreTarget = readFlag('restore');
if (restoreTarget !== undefined) {
  const candidates = listBackups();
  const source =
    restoreTarget === 'latest' || restoreTarget === ''
      ? candidates[candidates.length - 1]
      : path.resolve(restoreTarget);
  if (!source || !fs.existsSync(source)) {
    console.error(`找不到要恢复的备份：${restoreTarget}`);
    process.exit(2);
  }
  if (dryRun) {
    console.log(`[dry-run] 会用 ${source} 覆盖 ${configPath}`);
    process.exit(0);
  }
  const safety = backup();
  fs.copyFileSync(source, configPath);
  console.log(`已用 ${source} 覆盖 ${configPath}`);
  if (safety) console.log(`覆盖前的当前配置已另存为：${safety}`);
  console.log('注意：这是整文件恢复，会一并撤销此后的其它配置改动。');
  process.exit(0);
}

if (!action) {
  console.error('用法：tsx scripts/mcp-config.ts <add|remove> [--dry-run] [--server 名称] [--config 路径]');
  process.exit(2);
}

if (action === 'add' && !fs.existsSync(entryPath)) {
  console.error(`入口文件不存在：${entryPath}，请先 npm run build`);
  process.exit(2);
}
if (action === 'add' && !fs.existsSync(authFilePath)) {
  console.error(
    [
      `凭据文件不存在：${authFilePath}`,
      '请先用 flomo-cli 完成登录（flomo setup）或指定 --auth-file / FLOMO_AUTH_JSON。',
    ].join('\n'),
  );
  process.exit(2);
}

const exists = fs.existsSync(configPath);
if (action === 'remove' && !exists) {
  console.log(`配置文件不存在（${configPath}），无需撤销。`);
  process.exit(0);
}

const original = exists ? fs.readFileSync(configPath, 'utf8') : '';
const stripped = stripBlock(original).text;
const nextContent = action === 'add' ? `${stripped.trimEnd()}\n${renderBlock()}` : stripped;
const before = countSections(original);
const after = countSections(nextContent);

if (dryRun) {
  console.log(`[dry-run] 配置文件：${configPath}`);
  console.log(`[dry-run] 动作：${action === 'add' ? '写入 / 更新' : '移除'} [mcp_servers.${serverName}]`);
  console.log(`[dry-run] section 数量：${before} → ${after}`);
  if (action === 'add') {
    console.log('\n将写入的片段：');
    console.log(renderBlock().trimEnd());
  } else {
    const beforeLines = original.split('\n').length;
    const afterLines = nextContent.split('\n').length;
    console.log(`[dry-run] 文件行数：${beforeLines} → ${afterLines}（减少 ${beforeLines - afterLines} 行）`);
  }
  process.exit(0);
}

if (action === 'remove' && before === 0) {
  console.log(`配置里没有 [mcp_servers.${serverName}]，无需撤销。`);
  process.exit(0);
}

const saved = backup();
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, nextContent, 'utf8');

console.log(`配置文件：${configPath}`);
console.log(`${action === 'add' ? '已写入' : '已移除'} [mcp_servers.${serverName}]（section 数量 ${before} → ${after}）`);
if (saved) console.log(`改动前已备份：${saved}`);
if (action === 'remove') {
  console.log('重启 Codex 后该服务器不再加载；如需恢复：npm run mcp:deploy 或 --restore latest。');
} else {
  console.log(`重启 Codex 后加载；校验：npm run verify:deployed`);
}
