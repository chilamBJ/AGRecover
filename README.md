# AG Recover

> Real-time backup & one-click restore for Antigravity IDE conversations.

**AG crashes. Your chat history vanishes. Hours of AI context — gone.**

AG Recover runs silently in the background, backing up every conversation the moment it hits disk. When AG inevitably loses your data, you get it back in seconds — not hours of re-explaining context to AI.

---

## Why This Exists

Antigravity stores conversations as `.pb` (protobuf) files in `~/.gemini/antigravity/conversations/`. Through testing, we discovered that **AG periodically deletes these files** — conversations that survived multiple app restarts and even system reboots disappear without warning. The root cause appears to be either a cloud sync overwrite or an internal GC mechanism.

The official product offers no protection against this. So we built one.

## How It Works

AG Recover uses a **dual-layer backup** architecture with **three recovery paths**, ordered by reliability:

```
                    ┌──────────────────┐
                    │   File Watcher    │
                    │  conversations/   │
                    │  brain/           │
                    └────┬────────┬────┘
                         │        │
                   ┌─────▼──┐ ┌──▼──────┐
                   │   L1   │ │   L2    │
                   │ .pb    │ │ LS API  │
                   │ copy   │ │ → MD    │
                   └────────┘ └─────────┘
```

### Layer 1: Raw File Backup (Primary)

Watches `.pb` file changes → copies to backup dir with **write verification** (size check post-copy). Also backs up `state.vscdb` conversation index keys and `brain/` artifacts.

- Triggered by: file system events, debounced 2s
- **Never follows deletions** — if AG removes a `.pb`, our copy stays
- Detects and logs AG-side deletions: `[WARN] AG deleted xxx.pb — backup retained`

### Layer 2: Markdown Export (Fallback)

Connects to AG's Language Server via its internal gRPC-Web API (`GetAllCascadeTrajectories`, `GetCascadeTrajectorySteps`), converts structured conversation data to human-readable Markdown.

- Includes: user inputs, AI responses (with thinking), code edits (diffs), commands, web searches
- Throttled at 60s intervals per conversation
- Works independently of L1 — if LS is down, L1 still runs

### Why Three Recovery Paths

| Path | Method | Use Case | Invasiveness |
|------|--------|----------|--------------|
| **Selective Inject** | Copy single `.pb` → LS force-load | Restore specific conversations to native AG history | Minimal (one file) |
| **L1 Bulk Restore** | Copy all `.pb` + merge `state.vscdb` | Disaster recovery — restore everything | Medium |
| **L2 Read MD** | Let AI read backed-up `.md` files | Last resort when `.pb` files are unusable | Zero |

Selective Inject is the recommended path: it copies one `.pb` back to AG's conversation directory, then calls the LS API to force-load it. The conversation appears in AG's native history picker **instantly, without restart, without touching `state.vscdb`**.

## Self-Check Watchdog

AG Recover monitors its own health:

- **Consecutive L1 failure tracking** — 3+ failures triggers a modal error notification
- **5-minute health checks** — verifies backup dir is writable, source dir exists, watcher is alive
- **Stale sync detection** — compares source vs backup timestamps to catch dead watchers

## Install

```bash
# From source
git clone <repo>
cd ag-recover
npm install
npm run compile
npx vsce package --no-dependencies
```

Then in Antigravity: `Extensions: Install from VSIX...` → select `ag-recover-0.2.0.vsix` → Reload.

## Commands

| Command | Description |
|---------|-------------|
| `AG Recover: Force Sync Now` | Full sync immediately |
| `AG Recover: Inject to AG History` | Selective inject — restore specific conversations |
| `AG Recover: Restore All` | L1 bulk restore (merge or overwrite) |
| `AG Recover: Export Conversation` | Export selected conversation to `.md` |
| `AG Recover: Search Conversations` | Full-text search across backed-up conversations |
| `AG Recover: Open Backup Folder` | Open backup directory in file manager |
| `AG Recover: Show Sync Status` | Show output log |

## Configuration

```jsonc
{
  "agRecover.backupDir": "",              // Default: ~/.ag-recover
  "agRecover.autoBackup": true,           // Auto-backup on startup
  "agRecover.gitAutoCommit": false,       // Git auto-commit backups
  "agRecover.gitScope": ["conversations_md", "brain"],
  "agRecover.mdSyncIntervalSeconds": 60   // L2 MD sync interval
}
```

## Status Bar

```
$(sync~spin) AG Recover: Writing...     ← Syncing (animated)
$(pass-filled) AG Recover: 128 convs ✓  ← Success (green, 3s)
$(check) AG Recover: 128 convs | 2m ago ← Idle
$(warning) AG Recover: LS unreachable   ← Warning
$(error) AG Recover: Backup failed (3x) ← Critical
```

## Sidebar

TreeView grouped by date (Today / Yesterday / This Week / Older). Click to open backed-up conversation in Markdown.

## Architecture

```
src/
├── extension.ts     # Entry point, command registration
├── config.ts        # Settings + cross-platform AG path resolution
├── syncEngine.ts    # Core: file watcher, L1/L2 orchestration, health checks
├── lsClient.ts      # LS process discovery + gRPC-Web API client
├── mdFormatter.ts   # Conversation steps → Markdown
├── stateDb.ts       # state.vscdb read/write via sql.js
├── restore.ts       # L1 bulk restore (merge-first, overwrite fallback)
├── inject.ts        # Selective inject (single .pb + LS force-load)
├── treeView.ts      # Sidebar TreeView
└── statusBar.ts     # Status bar indicator
```

**Runtime dependency**: `sql.js` (WASM SQLite) — required for reading/writing `state.vscdb` conversation index.

## Platform Support

- ✅ macOS (primary)
- ⚠️ Windows (paths mapped, untested)
- ⚠️ Linux (paths mapped, untested)

LS port discovery includes a fix for the VPN/TUN `lsof` bug (filters by process name `language_` to avoid AirPlay port collision).

## License

MIT
