import * as vscode from 'vscode';
import { getConfig } from './config';
import { StatusBarManager } from './statusBar';
import { SyncEngine } from './syncEngine';
import { restoreConversations } from './restore';

let statusBar: StatusBarManager;
let syncEngine: SyncEngine;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('AG Recover');
  statusBar = new StatusBarManager();
  syncEngine = new SyncEngine(statusBar, outputChannel);

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('agRecover.forceSync', async () => {
      outputChannel.appendLine('[CMD] Force sync triggered');
      await syncEngine.fullSync();
    }),

    vscode.commands.registerCommand('agRecover.restore', async () => {
      outputChannel.appendLine('[CMD] Restore triggered');
      await restoreConversations(outputChannel);
    }),

    vscode.commands.registerCommand('agRecover.openBackupFolder', () => {
      const dir = getConfig().backupDir;
      vscode.env.openExternal(vscode.Uri.file(dir));
    }),

    vscode.commands.registerCommand('agRecover.showStatus', () => {
      outputChannel.show();
    }),

    statusBar,
  );

  // 启动同步引擎
  syncEngine.start().catch((e) => {
    outputChannel.appendLine(`[Init] Start failed: ${e.message}`);
    statusBar.setError('Start failed');
  });

  outputChannel.appendLine('[Init] AG Recover activated');
}

export function deactivate() {
  syncEngine?.dispose();
}
