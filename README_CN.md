# AG Recover

> Antigravity IDE 对话记录实时备份与一键恢复。

**AG 崩了，聊天记录没了，花了一整天给 AI 建立的上下文——全没了。**

AG Recover 在后台静默运行，对话内容落盘的瞬间就同步到备份目录。当 AG 不可避免地丢数据时，你可以在几秒内恢复，而不是花几小时重新给 AI 解释上下文。

---

## 为什么要做这个

Antigravity 把对话存为 `.pb`（protobuf）文件，路径在 `~/.gemini/antigravity/conversations/`。实测发现，**AG 会自行删除这些文件** —— 经历过多次应用重启甚至系统重启依然存在的对话记录，会在某天突然全部消失。推测原因是云端同步覆盖本地或内部 GC 机制。

官方没有任何保护措施。所以我们自己造了一个。

## 工作原理

AG Recover 采用**双层备份**架构，提供**三级恢复路径**，按可靠性排序：

```
                    ┌──────────────────┐
                    │    文件监听器     │
                    │  conversations/   │
                    │  brain/           │
                    └────┬────────┬────┘
                         │        │
                   ┌─────▼──┐ ┌──▼──────┐
                   │   L1   │ │   L2    │
                   │  .pb   │ │ LS API  │
                   │  副本   │ │ → MD    │
                   └────────┘ └─────────┘
```

### Layer 1：原始文件备份（主力）

监听 `.pb` 文件变化 → 复制到备份目录，并进行**写入校验**（复制后比对文件大小）。同时备份 `state.vscdb` 对话索引和 `brain/` artifacts。

- 触发方式：文件系统事件，2 秒防抖
- **永不跟随删除** —— AG 删了原文件，我们的副本照样保留
- 检测并记录 AG 侧删除行为：`[WARN] AG deleted xxx.pb — backup retained`

### Layer 2：Markdown 导出（降级方案）

连接 AG 的 Language Server 内部 gRPC-Web API（`GetAllCascadeTrajectories`、`GetCascadeTrajectorySteps`），将结构化对话数据转为人类可读的 Markdown。

- 内容包括：用户输入、AI 回复（含思考过程）、代码编辑（diff）、命令执行、Web 搜索
- 每个对话最小同步间隔 60 秒
- 与 L1 独立运行 —— LS 挂了也不影响 L1 备份

### 为什么是三级恢复

| 恢复路径 | 方式 | 适用场景 | 侵入性 |
|---------|------|---------|--------|
| **选择性注入** | 复制单个 `.pb` → LS 强制加载 | 恢复特定对话到 AG 原生历史 | 最低（只写一个文件） |
| **L1 批量恢复** | 复制全部 `.pb` + 合并 `state.vscdb` | 灾难恢复 —— 全量恢复 | 中等 |
| **L2 读 MD** | 让 AI 读取备份的 `.md` 文件恢复上下文 | 最后兜底，`.pb` 不可用时 | 零侵入 |

**推荐使用选择性注入**：只把选中的 `.pb` 复制回 AG 对话目录，然后调用 LS API 强制加载。对话**即时出现在 AG 原生历史列表中，不需重启，不碰 `state.vscdb`**。

## 自检 Watchdog

AG Recover 监控自身健康状态：

- **连续 L1 失败追踪** —— 连续 3 次失败触发弹窗告警
- **5 分钟定期健康检查** —— 验证备份目录可写、源目录存在、watcher 是否存活
- **过期同步检测** —— 比对源文件与备份文件时间戳，捕捉失效的 watcher

## 安装

```bash
# 从源码构建
git clone <repo>
cd ag-recover
npm install
npm run compile
npx vsce package --no-dependencies
```

在 Antigravity 中：`Extensions: Install from VSIX...` → 选择 `ag-recover-0.2.0.vsix` → Reload。

## 命令

| 命令 | 说明 |
|------|------|
| `AG Recover: Force Sync Now` | 立即执行全量同步 |
| `AG Recover: Inject to AG History` | 选择性注入 —— 恢复指定对话到原生历史 |
| `AG Recover: Restore All` | L1 批量恢复（优先合并，可选全覆盖） |
| `AG Recover: Export Conversation` | 导出选中对话为 `.md` 文件 |
| `AG Recover: Search Conversations` | 全文搜索已备份对话 |
| `AG Recover: Open Backup Folder` | 打开备份目录 |
| `AG Recover: Show Sync Status` | 查看输出日志 |

## 配置项

```jsonc
{
  "agRecover.backupDir": "",              // 默认: ~/.ag-recover
  "agRecover.autoBackup": true,           // 启动时自动备份
  "agRecover.gitAutoCommit": false,       // 备份后自动 git commit
  "agRecover.gitScope": ["conversations_md", "brain"],
  "agRecover.mdSyncIntervalSeconds": 60   // L2 MD 同步间隔（秒）
}
```

## 状态栏

```
$(sync~spin) AG Recover: Writing...     ← 同步中（动态动画）
$(pass-filled) AG Recover: 128 convs ✓  ← 成功（绿色，持续3秒）
$(check) AG Recover: 128 convs | 2m ago ← 常态
$(warning) AG Recover: LS unreachable   ← 警告
$(error) AG Recover: Backup failed (3x) ← 严重错误
```

## 侧边栏

TreeView 按日期分组（Today / Yesterday / This Week / Older），点击可直接打开备份对话的 Markdown 文件。

## 项目结构

```
src/
├── extension.ts     # 入口，命令注册
├── config.ts        # 配置 + 跨平台 AG 路径解析
├── syncEngine.ts    # 核心：文件监听、L1/L2 编排、健康检查
├── lsClient.ts      # LS 进程发现 + gRPC-Web API 客户端
├── mdFormatter.ts   # 对话步骤 → Markdown 格式化
├── stateDb.ts       # state.vscdb 读写（sql.js）
├── restore.ts       # L1 批量恢复（合并优先，覆盖需确认）
├── inject.ts        # 选择性注入（单个 .pb + LS 强制加载）
├── treeView.ts      # 侧边栏 TreeView
└── statusBar.ts     # 状态栏指示器
```

**运行时依赖**：`sql.js`（WASM SQLite）—— 用于读写 `state.vscdb` 对话索引。

## 平台支持

- ✅ macOS（主要开发和测试平台）
- ⚠️ Windows（路径已适配，未测试）
- ⚠️ Linux（路径已适配，未测试）

LS 端口发现包含 VPN/TUN 模式下 `lsof` bug 的 workaround（通过进程名 `language_` 过滤，避免 AirPlay 端口冲突）。

## License

MIT
