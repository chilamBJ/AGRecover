# AG Recover

> 🛡 Antigravity IDE 聊天记录实时备份 & 一键恢复 — 再也不怕对话丢失。

**AG 崩了。聊天记录没了。几个小时的 AI 上下文 — 全没了。**

AG Recover 在后台静默运行，实时备份每一条对话。当 AG 丢失你的数据时，几秒钟就能恢复 — 不需要重新向 AI 解释几个小时的上下文。

---

## 系统架构

AGR 采用**双组件解耦架构**：

```
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│     AGR Extension (v0.3)        │     │      AG Guardian (v1.0)      │
│     VS Code / AG 插件           │     │      macOS 菜单栏应用         │
│                                 │     │                              │
│  • 实时监控 .pb 文件变化          │     │  • AG 进程状态监控  🟢🟡⚪    │
│  • 自动备份到 ~/.ag-recover/     │ ──▶ │  • 对话列表可视化              │
│  • brain/ 文件夹同步             │文件  │  • 一键离线恢复               │
│  • Markdown 导出               │共享  │  • 打开备份文件夹              │
│  • TreeView 对话浏览器           │     │  • 恢复完成后启动 AG           │
└─────────────────────────────────┘     └──────────────────────────────┘
```

- **Extension** — 静默运行在 AG 内部，负责**持续备份**
- **Guardian** — 独立于 AG，负责**离线恢复**（直接写入 `state.vscdb`）

两者通过共享目录 `~/.ag-recover/` 交换数据，无需实时通信。

## 为什么需要这个

Antigravity 将对话存储为 `.pb` (protobuf) 文件。通过测试我们发现，**AG 会周期性删除这些文件** — 在多次重启甚至系统重启后都存活的对话，会在某个时刻突然消失。根因可能是云同步覆盖或内部 GC 机制。

官方产品没有任何保护措施。所以我们做了一个。

---

## 快速开始

### 1. 安装 Extension

```bash
git clone https://github.com/makcymal/AGRecover.git
cd AGRecover
npm install
npm run compile
npx vsce package --no-dependencies
```

在 Antigravity 中：`Extensions: Install from VSIX...` → 选择 `ag-recover-0.3.0.vsix` → Reload。

安装后 Extension 自动在后台运行，无需任何配置。

### 2. 构建 Guardian (macOS)

```bash
cd Guardian
chmod +x build.sh
./build.sh
```

构建完成后：

```bash
# 直接运行
open "AG Guardian.app"

# 或安装到 Applications
cp -r "AG Guardian.app" /Applications/

# 设为开机自启
# 系统设置 → 通用 → 登录项 → 添加 AG Guardian
```

菜单栏会出现 🟢 AGR 图标，点击弹出管理面板。

---

## Extension 功能

### 备份机制

| 层级 | 内容 | 方式 | 触发 |
|------|------|------|------|
| **L1** | `.pb` 原始文件 | 文件复制 + 写入校验 | 文件变化（防抖 2s） |
| **L2** | Markdown 导出 | LS API → 格式化 | 手动 Force Sync |
| **brain/** | 工件文件夹 | 文件夹同步 | 伴随 L1 |
| **state keys** | 对话索引 | vscdb 键值提取 | 伴随 L1 |

- **永不跟随删除** — AG 删了 `.pb`，备份不会删
- **写入校验** — 每次复制后检查文件大小
- **AG 删除检测** — 日志记录 `[WARN] AG deleted xxx.pb — backup retained`

### 命令

| 命令 | 说明 |
|------|------|
| `AG Recover: Force Sync Now` | 完整同步（L1 + L2 + Markdown） |
| `AG Recover: Open Backup Folder` | 打开备份目录 |
| `AG Recover: Show Sync Status` | 显示同步日志 |

### 侧边栏

左侧 TreeView 按日期分组（今天 / 昨天 / 本周 / 更早），点击查看备份的 Markdown 文件。

### 配置

```jsonc
{
  "agRecover.backupDir": "",              // 默认: ~/.ag-recover
  "agRecover.autoBackup": true,           // 启动时自动备份
  "agRecover.gitAutoCommit": false,       // Git 自动提交备份
  "agRecover.mdSyncIntervalSeconds": 60   // L2 同步间隔（秒）
}
```

---

## Guardian 功能

### 菜单栏状态

| 图标 | 状态 | 含义 |
|------|------|------|
| 🟢 AGR | 保护中 | AG 运行 + 备份活跃 |
| 🟡 AGR | 警告 | AG 运行 + 备份停滞 |
| ⚪ AGR | 待命 | AG 未运行 |
| 🔴 AGR | 离线 | 备份目录不存在 |

### 恢复流程

1. 在 Guardian 面板中查看缺失对话（自动检测 `state.vscdb` 索引差异）
2. 勾选要恢复的对话
3. **退出 AG** (Cmd+Q)
4. 点击 **"恢复"** 按钮
5. Guardian 直接写入 `state.vscdb`（注入前自动备份）
6. 点击 **"启动 AG"** → 对话已恢复

### 技术细节

- **离线注入** — 通过 `sqlite3` 命令行直接操作 `state.vscdb`
- **Protobuf 编解码** — Swift 原生实现 wire format 编解码器
- **注入前备份** — 自动创建 `state.vscdb.guardian_backup_*`
- **安全写入** — 合并而非覆盖现有索引数据

---

## 项目结构

```
AGRecover/
├── src/                      # Extension 源码 (TypeScript)
│   ├── extension.ts          # 入口 + 命令注册
│   ├── config.ts             # 配置 + 跨平台路径
│   ├── syncEngine.ts         # 核心: 文件监控 + L1/L2 备份
│   ├── lsClient.ts           # LS 进程发现 + gRPC-Web API
│   ├── mdFormatter.ts        # 对话 → Markdown
│   ├── stateDb.ts            # state.vscdb 读写
│   ├── protobufCodec.ts      # Protobuf wire format 编解码
│   ├── offlineRecover.ts     # 离线恢复数据准备
│   ├── restore.ts            # L1 批量恢复
│   ├── inject.ts             # 选择性注入
│   ├── treeView.ts           # 侧边栏 TreeView
│   └── statusBar.ts          # 状态栏指示器
│
├── Guardian/                 # Guardian 源码 (Swift)
│   ├── Package.swift
│   ├── build.sh              # 一键构建脚本
│   └── Sources/
│       ├── App.swift              # AppKit 入口 + 菜单栏
│       ├── Models/
│       │   └── AppState.swift     # 全局状态
│       ├── Services/
│       │   ├── StatusMonitor.swift     # AG 进程 + 备份扫描
│       │   ├── RecoveryManager.swift   # 离线注入逻辑
│       │   └── ProtobufCodec.swift     # Protobuf 编解码 (Swift)
│       └── Views/
│           └── PopoverView.swift      # Popover UI
│
├── package.json
└── README.md
```

## 平台支持

| 平台 | Extension | Guardian |
|------|-----------|----------|
| ✅ macOS | 完整支持 | 完整支持 |
| ⚠️ Windows | 路径已适配，未测试 | 不支持 |
| ⚠️ Linux | 路径已适配，未测试 | 不支持 |

## License

MIT
