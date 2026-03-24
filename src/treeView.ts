import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

interface ConvEntry {
  cascadeId: string;
  title: string;
  createdTime: string;
  lastModifiedTime: string;
  stepCount: number;
  hasMd: boolean;
}

export class ConversationTreeProvider implements vscode.TreeDataProvider<ConvTreeItem> {
  private _onDidChange = new vscode.EventEmitter<ConvTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private entries: ConvEntry[] = [];

  refresh() {
    this.entries = this.loadEntries();
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: ConvTreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: ConvTreeItem): ConvTreeItem[] {
    if (el) return []; // 不展开子级

    if (this.entries.length === 0) this.entries = this.loadEntries();

    // 按日期分组
    const now = new Date();
    const today = this.dateKey(now);
    const yesterday = this.dateKey(new Date(now.getTime() - 86400000));

    const groups = new Map<string, ConvEntry[]>();
    for (const e of this.entries) {
      const d = e.lastModifiedTime ? new Date(e.lastModifiedTime) : new Date(0);
      const key = this.dateKey(d);
      let label: string;
      if (key === today) label = 'Today';
      else if (key === yesterday) label = 'Yesterday';
      else if (now.getTime() - d.getTime() < 7 * 86400000) label = 'This Week';
      else label = 'Older';

      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(e);
    }

    // 如果只有一组，直接平铺不分组
    if (groups.size <= 1) {
      return this.entries.map((e) => this.toItem(e));
    }

    // 分组展示
    const items: ConvTreeItem[] = [];
    for (const label of ['Today', 'Yesterday', 'This Week', 'Older']) {
      const group = groups.get(label);
      if (!group || group.length === 0) continue;
      items.push(new ConvTreeItem(
        `📁 ${label} (${group.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        group.map((e) => this.toItem(e))
      ));
    }
    return items;
  }

  private toItem(e: ConvEntry): ConvTreeItem {
    const time = e.lastModifiedTime ? new Date(e.lastModifiedTime).toLocaleString() : '';
    const icon = e.hasMd ? '💬' : '📦';
    const item = new ConvTreeItem(
      `${icon} ${e.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = time;
    item.tooltip = `${e.title}\nSteps: ${e.stepCount}\nID: ${e.cascadeId}\n${time}`;
    item.contextValue = e.hasMd ? 'conversationWithMd' : 'conversationPbOnly';

    if (e.hasMd) {
      const mdPath = path.join(getConfig().backupDir, 'conversations_md', e.cascadeId, 'conversation.md');
      item.command = {
        command: 'vscode.open',
        title: 'Open Conversation',
        arguments: [vscode.Uri.file(mdPath)],
      };
    }
    item.cascadeId = e.cascadeId;
    return item;
  }

  private loadEntries(): ConvEntry[] {
    const config = getConfig();
    const entries: ConvEntry[] = [];

    // 从 conversations_md 加载 metadata
    const mdDir = path.join(config.backupDir, 'conversations_md');
    if (fs.existsSync(mdDir)) {
      for (const d of fs.readdirSync(mdDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('_')) continue;
        const metaPath = path.join(mdDir, d.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            entries.push({
              cascadeId: m.cascadeId || d.name,
              title: m.title || 'Untitled',
              createdTime: m.createdTime || '',
              lastModifiedTime: m.lastModifiedTime || '',
              stepCount: m.stepCount || 0,
              hasMd: true,
            });
          } catch {}
        }
      }
    }

    // 从 conversations/ 补充只有 .pb 的（还没生成 MD 的）
    const pbDir = path.join(config.backupDir, 'conversations');
    const mdIds = new Set(entries.map((e) => e.cascadeId));
    if (fs.existsSync(pbDir)) {
      for (const f of fs.readdirSync(pbDir).filter((f) => f.endsWith('.pb'))) {
        const id = f.replace('.pb', '');
        if (mdIds.has(id)) continue;
        const stat = fs.statSync(path.join(pbDir, f));
        entries.push({
          cascadeId: id,
          title: `[PB Only] ${id.substring(0, 8)}…`,
          createdTime: stat.birthtime.toISOString(),
          lastModifiedTime: stat.mtime.toISOString(),
          stepCount: 0,
          hasMd: false,
        });
      }
    }

    // 按最后修改时间排序
    entries.sort((a, b) => (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || ''));
    return entries;
  }

  private dateKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
}

export class ConvTreeItem extends vscode.TreeItem {
  children?: ConvTreeItem[];
  cascadeId?: string;

  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    children?: ConvTreeItem[],
  ) {
    super(label, collapsible);
    this.children = children;
  }
}

/** 带子节点展开支持的 Provider wrapper */
export class GroupedTreeProvider implements vscode.TreeDataProvider<ConvTreeItem> {
  private _onDidChange = new vscode.EventEmitter<ConvTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private inner: ConversationTreeProvider;

  constructor() {
    this.inner = new ConversationTreeProvider();
    this.inner.onDidChangeTreeData(() => this._onDidChange.fire(undefined));
  }

  refresh() { this.inner.refresh(); }

  getTreeItem(el: ConvTreeItem): vscode.TreeItem { return el; }

  getChildren(el?: ConvTreeItem): ConvTreeItem[] {
    if (el?.children) return el.children;
    return this.inner.getChildren(el);
  }
}
