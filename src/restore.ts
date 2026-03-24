import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getAGPaths } from './config';
import { restoreStateKeys } from './stateDb';

/** 复制目录（递归），返回复制文件数 */
function copyDir(src: string, dest: string, mode: 'merge' | 'overwrite'): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) {
      count += copyDir(s, d, mode);
    } else {
      if (mode === 'merge' && fs.existsSync(d)) continue;
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

export async function restoreConversations(out: vscode.OutputChannel) {
  const config = getConfig();
  const agPaths = getAGPaths();
  const backupConvDir = path.join(config.backupDir, 'conversations');

  if (!fs.existsSync(backupConvDir)) {
    vscode.window.showErrorMessage('AG Recover: 没有找到备份数据，请先运行同步。');
    return;
  }

  const pbFiles = fs.readdirSync(backupConvDir).filter((f) => f.endsWith('.pb'));
  if (pbFiles.length === 0) {
    vscode.window.showErrorMessage('AG Recover: 备份中没有对话文件。');
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `AG Recover: 恢复 ${pbFiles.length} 个对话？`,
    { modal: true, detail: '将备份的 .pb 文件复制回 AG 对话目录，并合并 state.vscdb 索引。' },
    '合并恢复（推荐）',
    '全量覆盖',
    '取消'
  );

  if (!choice || choice === '取消') return;
  const mode: 'merge' | 'overwrite' = choice === '全量覆盖' ? 'overwrite' : 'merge';

  try {
    fs.mkdirSync(agPaths.conversationsDir, { recursive: true });

    // 复制 .pb 文件
    let copied = 0;
    for (const f of pbFiles) {
      const s = path.join(backupConvDir, f), d = path.join(agPaths.conversationsDir, f);
      if (mode === 'merge' && fs.existsSync(d)) continue;
      fs.copyFileSync(s, d);
      copied++;
    }

    // 恢复 state.vscdb
    const stateBackup = path.join(config.backupDir, 'state', 'state_keys_backup.json');
    let stateResult = { restored: 0, skipped: 0, errors: [] as string[] };
    if (fs.existsSync(stateBackup) && fs.existsSync(agPaths.stateVscdb)) {
      stateResult = await restoreStateKeys(agPaths.stateVscdb, stateBackup, mode);
      // 如果合并失败，自动 fallback 到全覆盖
      if (mode === 'merge' && stateResult.errors.length > 0) {
        out.appendLine('[Restore] Merge had errors, retrying with overwrite...');
        stateResult = await restoreStateKeys(agPaths.stateVscdb, stateBackup, 'overwrite');
      }
    }

    // 恢复 brain artifacts
    const brainCount = copyDir(
      path.join(config.backupDir, 'brain'),
      agPaths.brainDir,
      mode
    );

    out.appendLine(`[Restore] Done: ${copied} .pb files, ${stateResult.restored} state keys, ${brainCount} brain files`);

    const action = await vscode.window.showInformationMessage(
      `AG Recover: 恢复完成！\n• ${copied} 个对话文件\n• ${stateResult.restored} 个状态索引\n• ${brainCount} 个 brain 文件\n\n请重启 Antigravity 以加载恢复的对话。`,
      '重启 Antigravity'
    );

    if (action === '重启 Antigravity') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (e: any) {
    out.appendLine(`[Restore] Error: ${e.message}`);
    vscode.window.showErrorMessage(`AG Recover: 恢复失败 — ${e.message}`);
  }
}
