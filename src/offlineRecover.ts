/**
 * offlineRecover.ts
 *
 * 离线恢复数据准备模块。
 * 负责从 LS API 收集摘要、构造 protobuf payload、生成注入脚本。
 * 这些数据供 AG Guardian 或手动 shell 脚本在 AG 退出后使用。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { getConfig, getAGPaths } from './config';
import { LSClient, TrajectorySummary } from './lsClient';
import { buildInjectPayload, encodeCascadeSummary, buildMapEntry, parseExistingEntryIds } from './protobufCodec';

const STATE_KEY = 'antigravityUnifiedStateSync.trajectorySummaries';

interface Heartbeat {
  timestamp: string;
  conversationCount: number;
  backupPbCount: number;
  lastSyncTime: string;
  extensionVersion: string;
  agRunning: boolean;
}

/**
 * 导出所有对话摘要到共享目录（供 Guardian 读取）
 */
export async function exportSummaries(
  lsClient: LSClient,
  out: vscode.OutputChannel
): Promise<void> {
  const config = getConfig();
  const stateDir = path.join(config.backupDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    const summaries = await lsClient.getAllTrajectories();
    const count = Object.keys(summaries).length;

    // 写摘要 JSON
    fs.writeFileSync(
      path.join(stateDir, 'summaries.json'),
      JSON.stringify(summaries, null, 2),
      'utf-8'
    );

    // 构造 protobuf payload
    const payload = buildPayloadFromSummaries(summaries);
    if (payload) {
      fs.writeFileSync(path.join(stateDir, 'inject_payload.bin'), payload);
    }

    out.appendLine(`[Offline] Exported ${count} summaries + payload`);
  } catch (e: any) {
    out.appendLine(`[Offline] Export failed: ${e.message}`);
  }
}

/**
 * 写心跳文件（供 Guardian 监控）
 */
export function writeHeartbeat(out: vscode.OutputChannel): void {
  const config = getConfig();
  const stateDir = path.join(config.backupDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const backupConvDir = path.join(config.backupDir, 'conversations');
  let backupPbCount = 0;
  try {
    backupPbCount = fs.readdirSync(backupConvDir).filter(f => f.endsWith('.pb')).length;
  } catch { /* dir may not exist */ }

  const summariesPath = path.join(stateDir, 'summaries.json');
  let convCount = 0;
  try {
    if (fs.existsSync(summariesPath)) {
      convCount = Object.keys(JSON.parse(fs.readFileSync(summariesPath, 'utf-8'))).length;
    }
  } catch { /* file may not exist or be corrupt */ }

  const heartbeat: Heartbeat = {
    timestamp: new Date().toISOString(),
    conversationCount: convCount,
    backupPbCount,
    lastSyncTime: new Date().toISOString(),
    extensionVersion: '0.3.0',
    agRunning: true,
  };

  fs.writeFileSync(
    path.join(stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat, null, 2),
    'utf-8'
  );
}

/**
 * 从摘要数据构造 protobuf payload（不读 state.vscdb，Guardian 负责合并）
 */
function buildPayloadFromSummaries(
  summaries: Record<string, TrajectorySummary>,
): Buffer | null {
  try {
    const summaryMap = new Map<string, TrajectorySummary>();
    for (const [id, s] of Object.entries(summaries)) {
      summaryMap.set(id, s);
    }
    return buildInjectPayload(null, summaryMap);
  } catch {
    return null;
  }
}

/**
 * 手动触发：准备离线恢复数据 + 生成 shell 注入脚本
 */
export async function prepareRecoveryCommand(
  lsClient: LSClient,
  out: vscode.OutputChannel
): Promise<void> {
  const config = getConfig();
  const agPaths = getAGPaths();
  const stateDir = path.join(config.backupDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Step 1: 确保 LS 可用
  const lsOk = lsClient.isConnected || (await lsClient.discover());
  if (!lsOk) {
    vscode.window.showErrorMessage('AG Recover: LS 不可达，无法收集对话数据。');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AG Recover: 准备恢复数据...', cancellable: false },
    async (progress) => {
      // Step 2: 收集摘要
      progress.report({ message: '收集对话摘要...', increment: 20 });
      const summaries = await lsClient.getAllTrajectories();
      const count = Object.keys(summaries).length;

      // 保存摘要
      fs.writeFileSync(
        path.join(stateDir, 'summaries.json'),
        JSON.stringify(summaries, null, 2),
        'utf-8'
      );

      // Step 3: 加载缺失对话到 LS
      progress.report({ message: '加载缺失对话...', increment: 20 });
      const agConvDir = agPaths.conversationsDir;
      const backupConvDir = path.join(config.backupDir, 'conversations');

      // 收集所有已知对话 ID（AG 原生 + 备份）
      const allPbIds = new Set<string>();
      for (const dir of [agConvDir, backupConvDir]) {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pb'))) {
            allPbIds.add(f.replace('.pb', ''));
          }
        }
      }

      const indexed = new Set(Object.keys(summaries));
      const missing = [...allPbIds].filter(id => !indexed.has(id));

      if (missing.length > 0) {
        for (const id of missing) {
          try {
            await lsClient.getTrajectorySteps(id);
          } catch { /* ignore load failures */ }
        }
        // 重新获取（包含新加载的）
        const updatedSummaries = await lsClient.getAllTrajectories();
        Object.assign(summaries, updatedSummaries);
        fs.writeFileSync(
          path.join(stateDir, 'summaries.json'),
          JSON.stringify(summaries, null, 2),
          'utf-8'
        );
      }

      const finalCount = Object.keys(summaries).length;

      // Step 4: 构造 protobuf payload
      progress.report({ message: '构造注入数据...', increment: 20 });
      const summaryMap = new Map<string, TrajectorySummary>();
      for (const [id, s] of Object.entries(summaries)) {
        summaryMap.set(id, s);
      }
      const payload = buildInjectPayload(null, summaryMap);
      const payloadPath = path.join(stateDir, 'inject_payload.bin');
      fs.writeFileSync(payloadPath, payload);

      // Step 5: 生成 shell 脚本
      progress.report({ message: '生成注入脚本...', increment: 20 });
      const scriptPath = path.join(stateDir, 'run_inject.sh');
      generateInjectScript(scriptPath, payloadPath, agPaths.stateVscdb);

      progress.report({ message: '完成', increment: 20 });

      // 结果提示
      const action = await vscode.window.showInformationMessage(
        `✅ 恢复数据准备完成！\n\n` +
        `• ${finalCount} 个对话摘要已保存\n` +
        `• protobuf payload 已生成\n` +
        `• 注入脚本已生成\n\n` +
        `下一步：Cmd+Q 退出 AG，然后在 Terminal 中运行：\n` +
        `bash ${scriptPath}`,
        { modal: true },
        '复制命令',
        '打开备份目录'
      );

      if (action === '复制命令') {
        await vscode.env.clipboard.writeText(`bash "${scriptPath}"`);
        vscode.window.showInformationMessage('已复制到剪贴板');
      } else if (action === '打开备份目录') {
        vscode.env.openExternal(vscode.Uri.file(stateDir));
      }
    }
  );
}

/**
 * 生成注入 shell 脚本
 */
function generateInjectScript(scriptPath: string, payloadPath: string, stateDbPath: string): void {
  const script = `#!/bin/bash
# AG Recover 离线注入脚本
# 在 AG 完全退出后运行此脚本恢复聊天记录
# 生成时间: ${new Date().toISOString()}

set -e

STATE_DB="${stateDbPath}"
PAYLOAD="${payloadPath}"
STATE_KEY="antigravityUnifiedStateSync.trajectorySummaries"

# 检查 AG 是否在运行
if pgrep -x "Antigravity" > /dev/null 2>&1 || pgrep -f "Antigravity.app" > /dev/null 2>&1; then
  echo "⚠️  AG 仍在运行！请先 Cmd+Q 完全退出 AG"
  echo "   确认要继续吗？(y/N)"
  read -r ans
  if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
    echo "已取消"
    exit 1
  fi
fi

if [ ! -f "$PAYLOAD" ]; then
  echo "❌ 找不到 payload 文件: $PAYLOAD"
  exit 1
fi

if [ ! -f "$STATE_DB" ]; then
  echo "❌ 找不到 state.vscdb: $STATE_DB"
  exit 1
fi

# 备份
BACKUP="$STATE_DB.recover_backup_$(date +%Y%m%d_%H%M%S)"
cp "$STATE_DB" "$BACKUP"
echo "✅ 备份: $BACKUP"

# 读取现有 protobuf
EXISTING_B64=$(sqlite3 "$STATE_DB" "SELECT value FROM ItemTable WHERE key = '$STATE_KEY';" 2>/dev/null || echo "")

# 读取 payload
PAYLOAD_B64=$(base64 < "$PAYLOAD")

if [ -n "$EXISTING_B64" ]; then
  # 合并：解码现有数据 + payload，拼接后重新 base64
  EXISTING_RAW=$(echo "$EXISTING_B64" | base64 -d)
  PAYLOAD_RAW=$(cat "$PAYLOAD")
  COMBINED_B64=$(cat <(echo "$EXISTING_B64" | base64 -d) "$PAYLOAD" | base64)
  
  sqlite3 "$STATE_DB" "UPDATE ItemTable SET value = '$COMBINED_B64' WHERE key = '$STATE_KEY';"
else
  sqlite3 "$STATE_DB" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('$STATE_KEY', '$PAYLOAD_B64');"
fi

echo "✅ 注入完成！现在启动 AG 即可看到恢复的对话"
echo ""
echo "   如需回滚: cp \\"$BACKUP\\" \\"$STATE_DB\\""
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
}
