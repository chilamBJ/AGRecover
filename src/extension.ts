import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { StatusBarManager } from './statusBar';
import { SyncEngine } from './syncEngine';
import { restoreConversations } from './restore';
import { GroupedTreeProvider } from './treeView';

let statusBar: StatusBarManager;
let syncEngine: SyncEngine;
let outputChannel: vscode.OutputChannel;
let treeProvider: GroupedTreeProvider;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('AG Recover');
  statusBar = new StatusBarManager();
  syncEngine = new SyncEngine(statusBar, outputChannel);

  // TreeView
  treeProvider = new GroupedTreeProvider();
  const treeView = vscode.window.createTreeView('agRecoverConversations', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,

    vscode.commands.registerCommand('agRecover.forceSync', async () => {
      outputChannel.appendLine('[CMD] Force sync');
      await syncEngine.fullSync();
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('agRecover.restore', async () => {
      outputChannel.appendLine('[CMD] Restore');
      await restoreConversations(outputChannel);
    }),

    vscode.commands.registerCommand('agRecover.export', async (item?: any) => {
      await exportConversation(item?.cascadeId);
    }),

    vscode.commands.registerCommand('agRecover.search', async () => {
      await searchConversations();
    }),

    vscode.commands.registerCommand('agRecover.openBackupFolder', () => {
      vscode.env.openExternal(vscode.Uri.file(getConfig().backupDir));
    }),

    vscode.commands.registerCommand('agRecover.showStatus', () => {
      outputChannel.show();
    }),

    vscode.commands.registerCommand('agRecover.refreshTree', () => {
      treeProvider.refresh();
    }),

    statusBar,
  );

  // 启动同步引擎，完成后刷新 TreeView
  syncEngine.start()
    .then(() => treeProvider.refresh())
    .catch((e) => {
      outputChannel.appendLine(`[Init] Start failed: ${e.message}`);
      statusBar.setError('Start failed');
    });

  outputChannel.appendLine('[Init] AG Recover v0.2 activated');
}

export function deactivate() {
  syncEngine?.dispose();
}

// ── 手动导出 ──

async function exportConversation(preselectedId?: string) {
  const config = getConfig();
  const mdDir = path.join(config.backupDir, 'conversations_md');

  if (!fs.existsSync(mdDir)) {
    vscode.window.showErrorMessage('AG Recover: 没有 MD 备份数据，请先运行同步。');
    return;
  }

  // 列出所有可导出的对话
  const conversations: { id: string; title: string; mdPath: string }[] = [];
  for (const d of fs.readdirSync(mdDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const metaPath = path.join(mdDir, d.name, 'metadata.json');
    const convMdPath = path.join(mdDir, d.name, 'conversation.md');
    if (!fs.existsSync(convMdPath)) continue;

    let title = d.name.substring(0, 8);
    if (fs.existsSync(metaPath)) {
      try {
        title = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).title || title;
      } catch {}
    }
    conversations.push({ id: d.name, title, mdPath: convMdPath });
  }

  if (conversations.length === 0) {
    vscode.window.showErrorMessage('AG Recover: 没有找到可导出的对话。');
    return;
  }

  // 如果有预选 ID，直接导出
  let selected: typeof conversations[0] | undefined;
  if (preselectedId) {
    selected = conversations.find((c) => c.id === preselectedId);
  }

  // 否则让用户选
  if (!selected) {
    const picked = await vscode.window.showQuickPick(
      conversations.map((c) => ({ label: c.title, description: c.id.substring(0, 8), detail: c.mdPath, _conv: c })),
      { placeHolder: '选择要导出的对话' }
    );
    if (!picked) return;
    selected = (picked as any)._conv;
  }

  if (!selected) return;

  // 选择导出位置
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir(),
      `${selected.title.replace(/[/\\:*?"<>|]/g, '_')}.md`
    )),
    filters: { Markdown: ['md'] },
  });

  if (!dest) return;

  fs.copyFileSync(selected.mdPath, dest.fsPath);
  const action = await vscode.window.showInformationMessage(
    `已导出: ${selected.title}`,
    '打开文件'
  );
  if (action === '打开文件') {
    vscode.window.showTextDocument(dest);
  }
}

// ── 搜索对话 ──

async function searchConversations() {
  const config = getConfig();
  const mdDir = path.join(config.backupDir, 'conversations_md');

  if (!fs.existsSync(mdDir)) {
    vscode.window.showErrorMessage('AG Recover: 没有 MD 备份，无法搜索。');
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: '搜索对话内容',
    placeHolder: '输入关键词...',
  });
  if (!query) return;

  const queryLower = query.toLowerCase();
  const results: { title: string; id: string; mdPath: string; matchLine: string }[] = [];

  for (const d of fs.readdirSync(mdDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const convMdPath = path.join(mdDir, d.name, 'conversation.md');
    if (!fs.existsSync(convMdPath)) continue;

    const content = fs.readFileSync(convMdPath, 'utf-8');
    if (!content.toLowerCase().includes(queryLower)) continue;

    // 找到第一个匹配行
    const lines = content.split('\n');
    const matchLine = lines.find((l) => l.toLowerCase().includes(queryLower)) || '';

    let title = d.name.substring(0, 8);
    const metaPath = path.join(mdDir, d.name, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try { title = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).title || title; } catch {}
    }

    results.push({ title, id: d.name, mdPath: convMdPath, matchLine: matchLine.trim().substring(0, 100) });
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(`没有找到包含 "${query}" 的对话。`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    results.map((r) => ({
      label: `💬 ${r.title}`,
      description: r.id.substring(0, 8),
      detail: r.matchLine,
      _path: r.mdPath,
    })),
    { placeHolder: `找到 ${results.length} 个对话` }
  );

  if (picked) {
    const doc = await vscode.workspace.openTextDocument((picked as any)._path);
    await vscode.window.showTextDocument(doc);

    // 跳转到匹配位置
    const text = doc.getText().toLowerCase();
    const idx = text.indexOf(queryLower);
    if (idx >= 0) {
      const pos = doc.positionAt(idx);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}
