# flomo-cli-mcp-fronted

把 flomo 能力以 **MCP 服务器**（stdio）的形式暴露给 agent 的独立包。

## 设计要点

- **进程内直连能力层**：不启动子进程、不拼 shell 命令、不解析 CLI 文本输出。
  调用方是 MCP 客户端，服务器内部直接调用能力函数（`listMemos` / `createMemo` / …）。
  实测每次调用省掉约 320ms 的 Node 启动开销，也彻底避免引号/编码/子进程权限这一类问题。
- **完全独立**：不依赖 `flomo-cli` 这个 npm 包，也不依赖 playwright。
  运行时依赖只有 `@modelcontextprotocol/sdk` 与 `zod`（2 个包 / 约 10MB）。
- **能力层来自 flomo-cli 的机械同步**：`src/core/**` 与其单测由 `npm run sync:core` 逐字复制，
  来源与 commit 记录在 `CORE_SOURCE.json`；`npm run check:core` 可检测漂移。
- **stdout 只用于 MCP 协议**：任何日志、告警、调试信息都走 stderr。

## 安装与构建

```powershell
npm install
npm run build          # 产出 dist/index.js
npm test               # 153 项单测（含同步来的能力层测试）
npm run smoke          # 端到端冒烟：真的用 MCP 客户端拉起服务器跑一遍
```

## 接入 MCP 客户端

凭据通过环境变量注入（推荐 `FLOMO_AUTH_JSON`，控制台取 token 的方式见 flomo-cli 的 README）：

```json
{
  "mcpServers": {
    "flomo": {
      "command": "node",
      "args": ["C:/Users/你/Desktop/Codex/flomo-cli-mcp-fronted/dist/index.js"],
      "env": {
        "FLOMO_AUTH_JSON": "{\"accessToken\":\"...\",\"deviceId\":\"...\",\"platform\":\"Web\",\"deviceModel\":\"Edge\"}"
      }
    }
  }
}
```

凭据解析顺序：`FLOMO_AUTH_JSON` → `FLOMO_AUTH_FILE`（指向 JSON 文件）→ `FLOMO_TOKEN`（裸 token）→ `<本包目录>/.flomo/auth.json`。
环境变量优先于文件，且一律只读（不写磁盘）。**缺凭据不会阻止服务器启动**，由 `flomo_health` 报告问题。

## 工具

| 工具 | 参数 | 说明 | 注解 |
| --- | --- | --- | --- |
| `flomo_list` | `tag?`、`limit?`(默认 20，≤200)、`full?` | 按时间倒序列出笔记，正文去壳 | readOnly |
| `flomo_get` | `ids[]`(1–20)、`full?` | 按 ID 取正文，部分失败记入 `failures` | readOnly |
| `flomo_search` | `queries[]`(1–5)、`tag?`、`scanLimit?`(默认 200，≤1000)、`maxResults?`(默认 20，≤100)、`full?` | 本地关键词匹配，多关键词为 OR；`scanned` 告诉你实际扫了多少条 | readOnly |
| `flomo_create` | `content`(≤20000) | 新建笔记，写入后回读校验 | 写 |
| `flomo_append` | `id`、`content` | 追加到末尾，回读校验 | 写 |
| `flomo_replace` | `id`、`content` | 整体覆盖，回读校验 | destructive |
| `flomo_delete` | `ids[]`(1–20) | 删除并逐条确认不可读 | destructive |
| `flomo_tags` | `name?` | 列出标签或查单个；`source` 标明来自服务端标签表还是按笔记统计 | readOnly |
| `flomo_health` | 无 | 凭据来源 / 账号 / 契约参数 / 数据规模 | readOnly |

**内容裁剪**：`full` 默认 `false`，单篇正文截断到 800 字并附 `truncated` 与 `content_length`；
需要全文时再传 `full: true`。这样 agent 不会一不小心把上下文灌爆。

**返回格式**：`content[0].text` 是一份 JSON ——
成功 `{ "ok": true, "tool": "flomo_list", "result": {...}, "meta": { authSource, readOnly, dataDir, warnings } }`，
失败 `{ "ok": false, "tool": "...", "result": null, "error": { kind, message, details, hint? } }` 且 `isError: true`。
`error.kind` 与 CLI 退出码一致：`AUTH` / `API` / `NETWORK` / `CONTRACT` / `USAGE`；`AUTH` 会附带凭据注入提示。

## 排查

```powershell
npm run list-tools     # 打印工具清单（名称/参数/注解）
npm run self-test      # 跑一次 flomo_health，凭据或网络有问题会直接暴露
FLOMO_MCP_DEBUG=1 node dist/index.js    # 服务器模式下的调试日志（写 stderr）
```

服务器可以被反复拉起，无状态；同一个 MCP 会话内的多次工具调用共用进程，但不缓存凭据与客户端，
每次调用都重新解析凭据与契约缓存，因此改环境变量后重启即可生效。

## 与 flomo-cli 的关系

`src/core/**` 是从 [flomo-cli](../flomo-cli) 复制过来的能力层（13 个文件），配套单测一并复制；
两个 CLI 层测试套件（`envelope`、`memo-args`）会被自动跳过。

```powershell
npm run sync:core      # 从 ../flomo-cli 重新同步，并更新 CORE_SOURCE.json（含来源 commit）
npm run check:core     # 只对比，报告漂移；CI 或本地自查用
```

来源仓库不在同级目录时，用 `FLOMO_CLI_REPO` 指定路径。

## 已知边界

- 只提供 stdio 传输，不含 HTTP/SSE。
- 工具结果为 JSON 文本，未使用 MCP 的 `outputSchema`/`structuredContent`。
- `flomo_append` / `flomo_replace` 只接受单个 `id`（批量写只在 CLI 提供），`flomo_delete` 最多 20 个。
- `flomo_search` 是本地匹配：`scanLimit` 越大越慢，`scanned` 小于笔记总数时结果可能不完整。
