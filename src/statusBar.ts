import * as vscode from 'vscode';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private syncCount = 0;
  private lastSyncTime: Date | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
    this.item.command = 'agRecover.showStatus';
    this.update();
    this.item.show();
  }

  setSyncing() {
    this.item.text = '$(sync~spin) AG Recover: Syncing...';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'Syncing conversations...';
  }

  setSynced(count: number) {
    this.syncCount = count;
    this.lastSyncTime = new Date();
    this.update();
  }

  setWarning(msg: string) {
    this.item.text = `$(warning) AG Recover: ${msg}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  setError(msg: string) {
    this.item.text = `$(error) AG Recover: ${msg}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  private update() {
    const timeStr = this.lastSyncTime ? this.relativeTime(this.lastSyncTime) : 'never';
    this.item.text = `$(check) AG Recover: ${this.syncCount} convs | ${timeStr}`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = `AG Recover running\n${this.syncCount} conversations backed up\nLast sync: ${timeStr}`;
  }

  private relativeTime(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  dispose() {
    this.item.dispose();
  }
}
