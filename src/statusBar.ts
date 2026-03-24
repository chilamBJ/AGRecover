import * as vscode from 'vscode';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private syncCount = 0;
  private lastSyncTime: Date | null = null;
  private dotTimer: NodeJS.Timeout | null = null;
  private dotCount = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'agRecover.showStatus';
    this.update();
    this.item.show();
  }

  /** 写入中：动态 ... 动画 */
  setSyncing() {
    this.stopDotAnimation();
    this.dotCount = 0;
    this.dotTimer = setInterval(() => {
      this.dotCount = (this.dotCount % 3) + 1;
      const dots = '.'.repeat(this.dotCount);
      this.item.text = `$(sync~spin) AG Recover: Writing${dots}`;
      this.item.backgroundColor = undefined;
    }, 400);
    this.item.text = '$(sync~spin) AG Recover: Writing.';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'Backing up conversations...';
  }

  /** 写入成功：绿色指示灯 */
  setSynced(count: number) {
    this.stopDotAnimation();
    this.syncCount = count;
    this.lastSyncTime = new Date();
    this.item.text = `$(pass-filled) AGR: ${this.syncCount} convs ✓`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = this.buildTooltip();

    // 3 秒后恢复常态显示
    setTimeout(() => this.update(), 3000);
  }

  /** 警告（L2 不可用等非致命问题） */
  setWarning(msg: string) {
    this.stopDotAnimation();
    this.item.text = `$(warning) AGR: ${msg}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  /** 错误（核心备份失败 — 必须引起注意） */
  setError(msg: string) {
    this.stopDotAnimation();
    this.item.text = `$(error) AGR: ${msg}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  /** 常态显示 */
  private update() {
    const timeStr = this.lastSyncTime ? this.relativeTime(this.lastSyncTime) : 'never';
    this.item.text = `$(check) AGR: ${this.syncCount} convs | ${timeStr}`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = this.buildTooltip();
  }

  private buildTooltip(): string {
    const timeStr = this.lastSyncTime ? this.relativeTime(this.lastSyncTime) : 'never';
    return `AGR running\n${this.syncCount} conversations backed up\nLast sync: ${timeStr}\n\nClick for details`;
  }

  private relativeTime(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private stopDotAnimation() {
    if (this.dotTimer) {
      clearInterval(this.dotTimer);
      this.dotTimer = null;
    }
  }

  dispose() {
    this.stopDotAnimation();
    this.item.dispose();
  }
}
