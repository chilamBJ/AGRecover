# 现有 Antigravity 插件分析报告

> 分析日期：2026-03-24
> 目的：为自建 AG_recover 插件提供参考，避免踩坑

---

## 1. Antigravity Backup (`hhgold.antigravity-backup` v1.1.19)

### 基本信息

| 项目 | 值 |
|------|-----|
| 发布者 | HHGold |
| 仓库 | https://github.com/HHGold/antigravity-backup-extension.git |
| 入口 | `./out/extension.js` → `backupLogic.js` |
| 依赖 | `sql.js` (纯 WASM SQLite) |
| 平台 | ❌ **仅 Windows**（使用 robocopy + APPDATA 环境变量） |

### 功能架构

**核心机制**：将 Antigravity 的本地数据用 `robocopy /MIR` 镜像同步到一个"网络路径"。

**备份范围**：

| 类别 | 数据 | 来源路径 |
|------|------|----------|
| 对话内容 | `.pb` 文件 | `~/.gemini/antigravity/conversations/` |
| Brain 索引 | 索引数据 | `~/.gemini/antigravity/brain/` |
| 知识库 | KI 数据 | `~/.gemini/antigravity/knowledge/` |
| 全局工作流 | 工作流文件 | `~/.gemini/antigravity/global_workflows/` |
| 其他目录 | implicit, annotations, context_state | `~/.gemini/antigravity/` 下 |
| 用户设置 | `user_settings.pb` | `~/.gemini/antigravity/` |
| 全局规则 | `GEMINI.md` | `~/.gemini/` |
| UI 状态 | workspaceStorage, History | `APPDATA/Antigravity/User/` |
| 对话列表索引 | `state.vscdb` 中特定 key | `APPDATA/Antigravity/User/globalStorage/` |

**排除项（隐私保护）**：

- `installation_id` — 每台机器唯一身份
- `globalStorage` — 包含 GitHub/Google 登录 token

### state.vscdb 精准合并逻辑

插件使用 `sql.js`（纯 WASM）打开 `state.vscdb`（SQLite），**只操作 `ItemTable` 表中的特定 key**：

**备份的 key**：
```
antigravityUnifiedStateSync.scratchWorkspaces
antigravityUnifiedStateSync.sidebarWorkspaces
antigravityUnifiedStateSync.trajectorySummaries
antigravityUnifiedStateSync.modelPreferences
antigravityUnifiedStateSync.agentPreferences
antigravityUnifiedStateSync.tabPreferences
antigravityUnifiedStateSync.theme
antigravityUnifiedStateSync.windowPreferences
antigravityUnifiedStateSync.editorPreferences
history.recentlyOpenedPathsList
```

**绝不触碰的 key（auth token）**：
```
antigravityUnifiedStateSync.oauthToken
antigravityAuthStatus
vscode.github-authentication
vscode.microsoft-authentication
google.antigravity
```

### macOS 兼容性问题

1. **`robocopy` 不存在** — macOS 没有该命令，需用 `rsync -a --delete` 替代
2. **`process.env.APPDATA` 为空** — macOS 的对应路径是 `~/Library/Application Support/Antigravity/User/globalStorage`
3. **网络路径格式** — 默认值 `\\gy\share\...` 是 Windows UNC 路径，macOS 不适用

### 关键路径映射（Windows → macOS）

| 数据 | Windows | macOS |
|------|---------|-------|
| Gemini 数据 | `%USERPROFILE%\.gemini\antigravity\` | `~/.gemini/antigravity/` |
| AppData | `%APPDATA%\Antigravity\User\` | `~/Library/Application Support/Antigravity/User/` |
| globalStorage | `%APPDATA%\Antigravity\User\globalStorage\` | `~/Library/Application Support/Antigravity/User/globalStorage/` |
| state.vscdb | 在 globalStorage 下 | 在 globalStorage 下 |

---

## 2. Antigravity History (`neo1027144.antigravity-history` v0.1.9)

### 基本信息

| 项目 | 值 |
|------|-----|
| 发布者 | neo1027144 |
| 仓库 | https://github.com/neo1027144-creator/antigravity-history-vscode |
| 入口 | `./dist/extension.js` (esbuild 打包 + 混淆) |
| 依赖 | 无运行时依赖 |
| 平台 | ✅ 跨平台（Windows / macOS / Linux 分支代码） |

### 功能架构

**核心机制**：通过 HTTPS 连接本地运行的 Language Server 进程，调用其 gRPC-Web API 获取对话数据。

**工作流程**：

```
1. 发现进程
   ├─ Windows: PowerShell Get-CimInstance 查找 language_server* 进程
   ├─ macOS:   pgrep -f language_server_macos
   └─ Linux:   pgrep -f language_server

2. 提取 CSRF Token
   └─ 从进程命令行参数匹配 --csrf_token <TOKEN>

3. 发现端口
   ├─ Windows: netstat -ano 过滤 PID + LISTENING
   └─ macOS/Linux: lsof -p PID -i -P -n 过滤 LISTEN

4. 调用 API
   └─ HTTPS POST localhost:PORT/exa.language_server_pb.LanguageServerService/<Method>
      Headers:
        Content-Type: application/json
        Connect-Protocol-Version: 1
        X-Codeium-Csrf-Token: <TOKEN>
```

### Language Server API 端点

| 方法 | 用途 | 超时 |
|------|------|------|
| `GetAllCascadeTrajectories` | 获取所有对话摘要列表 | 3s |
| `GetCascadeTrajectorySteps` | 获取单个对话的完整步骤 | 30s |

**请求参数**（GetCascadeTrajectorySteps）：
```json
{
  "cascadeId": "uuid",
  "startIndex": 0,
  "endIndex": 1010
}
```

**返回数据结构**（对话摘要）：
```json
{
  "trajectorySummaries": {
    "<cascadeId>": {
      "summary": "对话标题",
      "stepCount": 820,
      "status": "CASCADE_RUN_STATUS_IDLE",
      "createdTime": "2026-03-19T17:11:12.092140Z",
      "lastModifiedTime": "...",
      "trajectoryId": "...",
      "workspaces": [{ "workspaceFolderAbsoluteUri": "file:///..." }],
      "lastUserInputTime": "...",
      "lastUserInputStepIndex": 0
    }
  }
}
```

### 步骤类型（Step Types）

| 类型常量 | 含义 | 关键字段 |
|---------|------|----------|
| `CORTEX_STEP_TYPE_USER_INPUT` | 用户输入 | `userInput.userResponse` |
| `CORTEX_STEP_TYPE_PLANNER_RESPONSE` | AI 回复 | `plannerResponse.response`, `.thinking` |
| `CORTEX_STEP_TYPE_CODE_ACTION` | 代码编辑 | `codeAction.description`, `.actionResult.edit.diff` |
| `CORTEX_STEP_TYPE_RUN_COMMAND` | 执行命令 | `runCommand.commandLine`, `.combinedOutput` |
| `CORTEX_STEP_TYPE_VIEW_FILE` | 查看文件 | `viewFile.absolutePathUri` |
| `CORTEX_STEP_TYPE_FIND` | 搜索文件 | `find.query` |
| `CORTEX_STEP_TYPE_LIST_DIRECTORY` | 列出目录 | `listDirectory.directoryPath` |
| `CORTEX_STEP_TYPE_SEARCH_WEB` | 网络搜索 | `searchWeb.query`, `.summary` |
| `CORTEX_STEP_TYPE_READ_URL_CONTENT` | 读取URL | `readUrlContent.url` |
| `CORTEX_STEP_TYPE_COMMAND_STATUS` | 命令状态 | - |

### 缓存策略

- 缓存文件：`~/.gemini/antigravity-history/cache.json`
- 格式：`{ version: 1, updatedAt: "ISO时间", conversations: {...} }`
- 启动时先加载缓存，再从 LS API 增量更新

### "激活"未加载对话的机制

插件发现 `~/.gemini/antigravity/conversations/` 下有 `.pb` 文件但不在 API 返回的列表中时，会逐个向 LS 发送 `GetCascadeTrajectorySteps` 请求（只取 1 步），强制 LS 加载该对话，然后重新获取完整列表。

### macOS 已知 Bug

**端口发现失败（VPN/TUN 模式下）**：

`lsof -p PID -i -P -n` 在 VPN TUN 模式下返回**全系统所有进程**的端口列表，而非仅目标 PID 的端口。插件取第一个 LISTEN 端口时会拿到 ControlCenter:7000（AirPlay），导致 API 请求发到错误端口，返回空数据。

**修复方案**：过滤 lsof 输出时增加进程名匹配：
```diff
- if(r.includes("LISTEN"))
+ if(r.includes("LISTEN") && r.includes("language_"))
```

---

## 3. 关键设计启示（给 AG_recover）

### 数据获取有两条路

| 方式 | 优点 | 缺点 |
|-----|------|------|
| **文件系统直接复制** | 简单可靠，不依赖 LS 运行 | 拿不到解析后的对话内容（.pb 是 protobuf 二进制） |
| **Language Server API** | 获取结构化对话数据（含 thinking、diff 等） | 需要 LS 运行中，需要动态发现端口和 CSRF |

### 建议架构

1. **数据备份**：直接用 `rsync` 或 `fs.cpSync` 复制文件系统（不依赖 LS）
2. **数据浏览/导出**：通过 LS API 获取结构化数据
3. **端口发现**：不要依赖 `lsof`，改用**直接从命令行参数获取**（已有 PID → `ps` 拿 args → 提取 `--random_port` 分配的端口 → 逐个 HTTPS 探测）
4. **跨平台**：一开始就考虑 macOS / Windows / Linux

### Language Server 进程信息

实际进程名和参数模式：
```
/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm
  --enable_lsp
  --csrf_token <UUID>
  --extension_server_port <PORT>
  --extension_server_csrf_token <UUID>
  --random_port
  --workspace_id <ENCODED_PATH>
  --cloud_code_endpoint http://127.0.0.1:18605
  --app_data_dir antigravity
  --parent_pipe_path /var/folders/.../server_<HASH>
```

**注意**：`--random_port` 意味着端口是动态分配的，必须通过 `lsof` 或端口扫描发现。每个 workspace 打开一个独立的 LS 进程。

### 完整数据路径清单

```
~/.gemini/
├── GEMINI.md                          # 全局规则
└── antigravity/
    ├── user_settings.pb               # 用户设置
    ├── conversations/                 # 对话 protobuf 文件
    │   ├── <cascadeId>.pb
    │   └── ...
    ├── brain/                         # Brain 索引（含 KI + 对话 artifacts）
    │   └── <conversationId>/
    ├── knowledge/                     # 知识库
    ├── global_workflows/              # 全局工作流
    ├── implicit/                      # 隐式数据
    ├── annotations/                   # 标注
    └── context_state/                 # 上下文状态

~/Library/Application Support/Antigravity/User/
├── globalStorage/
│   └── state.vscdb                    # SQLite，存对话列表索引 + auth token
├── workspaceStorage/                  # 工作区状态
└── History/                           # 命令历史
```
