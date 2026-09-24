/**
 * 从 flomo-cli 机械同步能力层（src/core）与其单元测试到本包。
 *
 * 设计意图：本包完全独立运行，不依赖 flomo-cli 这个 npm 包，
 * 因此把 core 逐字复制进来，并用这个脚本保证"复制"是可复现、可追溯的。
 *
 *   npm run sync:core     # 复制并写 CORE_SOURCE.json
 *   npm run check:core    # 只对比，报告漂移（CI/本地自查用）
 *
 * 可用 FLOMO_CLI_REPO 指定来源仓库路径，默认取同级目录 ../flomo-cli。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const checkOnly = process.argv.includes('--check');

const sourceRepo = path.resolve(
  process.env.FLOMO_CLI_REPO?.trim() || path.join(root, '..', 'flomo-cli'),
);
const sourceCore = path.join(sourceRepo, 'src', 'core');
const sourceTests = path.join(sourceRepo, 'tests');
const targetCore = path.join(root, 'src', 'core');
const targetTests = path.join(root, 'tests');

if (!fs.existsSync(sourceCore)) {
  console.error(
    [
      `找不到来源仓库的 core 目录：${sourceCore}`,
      '请把 flomo-cli 放在同级目录，或设置环境变量 FLOMO_CLI_REPO 指向它。',
    ].join('\n'),
  );
  process.exit(2);
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

const manifestPath = path.join(root, 'CORE_SOURCE.json');

/** 上一次同步托管了哪些文件：本包自有的文件（如 tests/tools.test.ts）不算漂移。 */
function managedFilesFromManifest(): string[] {
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(read(manifestPath)) as {
      files?: { core?: string[]; tests?: string[] };
    };
    return [...(manifest.files?.core ?? []), ...(manifest.files?.tests ?? [])];
  } catch {
    return [];
  }
}

const previouslyManaged = managedFilesFromManifest();

/** 只同步不引用 CLI 层的测试：引用 ../src/cli 的套件在本包无法运行。 */
function isPortableTest(name: string, body: string): boolean {
  return name.endsWith('.test.ts') && !/\.\.\/src\/cli/.test(body);
}

const coreFiles = listFiles(sourceCore);
const testFiles: string[] = [];
const skippedTests: string[] = [];
for (const name of listFiles(sourceTests)) {
  if (!name.endsWith('.test.ts')) continue;
  const body = read(path.join(sourceTests, name));
  if (isPortableTest(name, body)) testFiles.push(name);
  else skippedTests.push(name);
}

const drift: string[] = [];
const written: { path: string; lines: number }[] = [];

function syncFile(source: string, target: string, relative: string): void {
  const content = read(source);
  const current = fs.existsSync(target) ? read(target) : null;
  if (current === content) return;
  if (checkOnly) {
    drift.push(current === null ? `缺失：${relative}` : `内容不同：${relative}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  written.push({ path: relative, lines: content.split('\n').length });
}

for (const name of coreFiles) {
  syncFile(path.join(sourceCore, name), path.join(targetCore, name), `src/core/${name}`);
}
for (const name of testFiles) {
  syncFile(path.join(sourceTests, name), path.join(targetTests, name), `tests/${name}`);
}

// 只对"上一次同步托管过的文件"做删除检查：来源已删除 → 本地也应删除。
// 本包自己新增的文件（例如 tests/tools.test.ts）不在托管清单里，不算漂移。
const wanted = new Set([
  ...coreFiles.map((name) => `src/core/${name}`),
  ...testFiles.map((name) => `tests/${name}`),
]);
const staleFiles = previouslyManaged.filter((relative) => !wanted.has(relative));
for (const relative of staleFiles) {
  drift.push(`来源已删除，本地仍存在：${relative}`);
}

function sourceCommit(): string | null {
  try {
    return execFileSync('git', ['-C', sourceRepo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

if (checkOnly) {
  if (drift.length === 0) {
    console.log(`core 与来源一致（${coreFiles.length} 个文件 + ${testFiles.length} 个测试）`);
    console.log(`来源：${sourceRepo}${sourceCommit() ? ` @ ${sourceCommit()?.slice(0, 8)}` : ''}`);
    process.exit(0);
  }
  console.error(`检测到 ${drift.length} 处漂移：`);
  for (const item of drift) console.error(`  - ${item}`);
  console.error('执行 npm run sync:core 同步。');
  process.exit(1);
}

for (const relative of staleFiles) {
  fs.rmSync(path.join(root, relative), { force: true });
}

const totals = {
  core: coreFiles.length,
  coreLines: coreFiles.reduce((sum, name) => sum + read(path.join(sourceCore, name)).split('\n').length, 0),
  tests: testFiles.length,
};

const manifest = {
  sourceRepo: path.relative(root, sourceRepo).replace(/\\/g, '/'),
  sourceCommit: sourceCommit(),
  syncedAt: new Date().toISOString(),
  files: {
    core: coreFiles.map((name) => `src/core/${name}`),
    tests: testFiles.map((name) => `tests/${name}`),
    skippedTests,
  },
  totals,
};
fs.writeFileSync(path.join(root, 'CORE_SOURCE.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`已从 ${manifest.sourceRepo} 同步 core：${totals.core} 个文件 / ${totals.coreLines} 行`);
console.log(`可运行测试：${totals.tests} 个${skippedTests.length > 0 ? `（跳过 CLI 层套件：${skippedTests.join(', ')}）` : ''}`);
console.log(
  `本次写入 ${written.length} 个文件${
    staleFiles.length > 0 ? `，清理 ${staleFiles.length} 个来源已删除的文件` : ''
  }；CORE_SOURCE.json 已更新`,
);
