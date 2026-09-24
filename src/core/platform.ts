/**
 * 与宿主平台相关的默认值集中在这里，避免 win32/darwin 判断散落各处。
 * 注意：这里只影响"默认值选择"，不改变任何已实测的接口协议常量。
 */
import { FlomoError } from './errors.js';
import { execFileSync } from 'node:child_process';

export type BrowserChannel = 'msedge' | 'chrome' | 'chromium';

/** 各平台优先尝试的系统浏览器；都不存在时回退到 Playwright 自带的 Chromium。 */
export function browserCandidates(platform: NodeJS.Platform = process.platform): BrowserChannel[] {
  if (platform === 'win32') return ['msedge', 'chrome', 'chromium'];
  if (platform === 'darwin') return ['chrome', 'msedge', 'chromium'];
  return ['chrome', 'chromium'];
}

/** 把 `--browser` 取值解析成候选列表；未指定时返回 null 交由调用方使用平台默认。 */
export function resolveBrowserArgument(
  browser?: string | undefined,
  platform: NodeJS.Platform = process.platform,
): BrowserChannel[] | null {
  const value = browser?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'msedge' || value === 'edge') return ['msedge'];
  if (value === 'chrome') return ['chrome'];
  if (value === 'chromium') return ['chromium'];
  throw new FlomoError(
    'USAGE',
    `不支持的 --browser 取值：${browser}（可选 msedge / chrome / chromium）`,
  );
}

/** 结束标准输入的按键提示：Windows 是 Ctrl+Z 再回车，类 Unix 是 Ctrl+D。 */
export function stdinEndHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Ctrl+Z 再回车' : 'Ctrl+D';
}

/** 交互式浏览器登录在本平台是否默认可用（仅用于提示文案）。 */
export function browserLoginSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/** 各平台读取剪贴板的候选命令（按顺序尝试）。 */
export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === 'win32') {
    return [{ command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }];
  }
  if (platform === 'darwin') return [{ command: 'pbpaste', args: [] }];
  return [
    { command: 'wl-paste', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
  ];
}

/** 读取剪贴板文本；全部候选失败时返回 null（由调用方给出可操作的提示）。 */
export function readClipboardText(platform: NodeJS.Platform = process.platform): string | null {
  for (const candidate of clipboardCommands(platform)) {
    try {
      const text = execFileSync(candidate.command, candidate.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (text.trim().length > 0) return text;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}
