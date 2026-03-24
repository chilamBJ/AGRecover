import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getAGPaths } from './config';
import { StatusBarManager } from './statusBar';
import { LSClient, TrajectorySummary } from './lsClient';
import { formatConversationToMd, formatIndexMd, ConversationMeta } from './mdFormatter';
import { backupStateKeys } from './stateDb';

export class SyncEngine {
  private watcher: vscode.FileSystemWatcher | null = null;
  private brainWatcher: vscode.FileSystemWatcher | null = null;
  private lsClient: LSClient;
  private statusBar: StatusBarManager;
  private out: vscode.OutputChannel;
  private metas = new Map<string, ConversationMeta>();
  private l2LastSync = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];
  private syncing = false;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private consecutiveL1Failures = 0;
  private lastSuccessfulL1: Date | null = null;
  private static readonly MAX_L1_FAILURES = 3;
  private static readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

  constructor(statusBar: StatusBarManager, outputChannel: vscode.OutputChannel) {
    this.statusBar = statusBar;
    this.out = outputChannel;
    this.lsClient = new LSClient((msg) => this.out.appendLine(msg));
  }

  get ls(): LSClient { return this.lsClient; }

  async start() {
    const config = getConfig();
    if (!config.autoBackup) {
      this.out.appendLine('[Sync] Auto backup disabled');
      return;
    }

    const agPaths = getAGPaths();

    // 确保备份目录
    for (const sub of ['conversations', 'conversations_md', 'brain', 'state']) {
      this.ensureDir(path.join(config.backupDir, sub));
    }

    // git init
    if (config.gitAutoCommit) this.gitInit(config.backupDir);

    // 初始全量同步
    await this.fullSync();

    // 监听 .pb 文件变化
    if (fs.existsSync(agPaths.conversationsDir)) {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(agPaths.conversationsDir), '*.pb')
      );
      this.watcher.onDidChange((uri) => this.onPbChanged(uri));
      this.watcher.onDidCreate((uri) => this.onPbChanged(uri));
      this.disposables.push(this.watcher);
    }

    // 监听 brain 目录
    if (fs.existsSync(agPaths.brainDir)) {
      this.brainWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(agPaths.brainDir), '**/*')
      );
      this.brainWatcher.onDidChange((uri) => this.onBrainChanged(uri));
      this.brainWatcher.onDidCreate((uri) => this.onBrainChanged(uri));
      this.disposables.push(this.brainWatcher);
    }

    // 启动健康检查定时器
    this.healthCheckTimer = setInterval(() => this.healthCheck(), SyncEngine.HEALTH_CHECK_INTERVAL);

    this.out.appendLine('[Sync] Engine started');
  }

  /** 全量同步 */
  async fullSync() {
    if (this.syncing) return;
    this.syncing = true;
    this.statusBar.setSyncing();
    const config = getConfig();
    const agPaths = getAGPaths();

    try {
      // L1: .pb 文件
      this.syncFiles(agPaths.conversationsDir, path.join(config.backupDir, 'conversations'), '.pb');

      // L1: brain artifacts
      this.syncDirRecursive(agPaths.brainDir, path.join(config.backupDir, 'brain'));

      // L1: state.vscdb keys
      await backupStateKeys(agPaths.stateVscdb, path.join(config.backupDir, 'state', 'state_keys_backup.json'));

      // L1 成功 → 重置失败计数
      this.consecutiveL1Failures = 0;
      this.lastSuccessfulL1 = new Date();

      // L2: MD 导出
      const lsOk = await this.lsClient.discover();
      if (lsOk) {
        await this.syncAllMd(config);
      } else {
        this.out.appendLine('[Sync] LS unavailable — L1 only');
        this.statusBar.setWarning('LS unreachable — L1 active');
      }

      this.writeMeta(config.backupDir);
      if (config.gitAutoCommit) this.gitCommit(config.backupDir, config.gitScope);

      const count = this.countPb(config.backupDir);
      this.statusBar.setSynced(count);
      this.out.appendLine(`[Sync] Full sync done: ${count} conversations`);
    } catch (e: any) {
      this.onL1Failure(`fullSync: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  // ── 事件处理 ──

  private onPbChanged(uri: vscode.Uri) {
    const cascadeId = path.basename(uri.fsPath, '.pb');
    const existing = this.debounceTimers.get(cascadeId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(cascadeId, setTimeout(async () => {
      this.debounceTimers.delete(cascadeId);
      await this.syncOne(cascadeId, uri.fsPath);
    }, 2000));
  }

  private onBrainChanged(uri: vscode.Uri) {
    const config = getConfig();
    const agPaths = getAGPaths();
    const rel = path.relative(agPaths.brainDir, uri.fsPath);
    const dest = path.join(config.backupDir, 'brain', rel);
    try {
      this.ensureDir(path.dirname(dest));
      fs.copyFileSync(uri.fsPath, dest);
    } catch (e: any) {
      this.out.appendLine(`[Sync] Brain copy failed: ${e.message}`);
    }
  }

  // ── 单个对话同步 ──

  private async syncOne(cascadeId: string, pbPath: string) {
    const config = getConfig();
    this.statusBar.setSyncing();

    try {
      // L1
      fs.copyFileSync(pbPath, path.join(config.backupDir, 'conversations', `${cascadeId}.pb`));
      await backupStateKeys(
        getAGPaths().stateVscdb,
        path.join(config.backupDir, 'state', 'state_keys_backup.json')
      );
      this.consecutiveL1Failures = 0;
      this.lastSuccessfulL1 = new Date();

      // L2（节流）
      const last = this.l2LastSync.get(cascadeId) || 0;
      if (Date.now() - last >= config.mdSyncIntervalSeconds * 1000) {
        const ok = this.lsClient.isConnected || (await this.lsClient.discover());
        if (ok) {
          await this.syncOneMd(cascadeId, config);
          this.l2LastSync.set(cascadeId, Date.now());
        }
      }

      if (config.gitAutoCommit) this.gitCommit(config.backupDir, config.gitScope);
      this.statusBar.setSynced(this.countPb(config.backupDir));
    } catch (e: any) {
      this.onL1Failure(`syncOne(${cascadeId.substring(0, 8)}…): ${e.message}`);
    }
  }

  // ── L2 MD 同步 ──

  private async syncAllMd(config: ReturnType<typeof getConfig>) {
    const summaries = await this.lsClient.getAllTrajectories();

    for (const [id, s] of Object.entries(summaries)) {
      const meta = this.toMeta(id, s);
      this.metas.set(id, meta);

      // 跳过未修改的对话
      const metaPath = path.join(config.backupDir, 'conversations_md', id, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          const old = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (old.lastModifiedTime === s.lastModifiedTime) continue;
        } catch {}
      }

      await this.syncOneMd(id, config, meta);
    }

    // 写索引
    fs.writeFileSync(
      path.join(config.backupDir, 'conversations_md', '_index.md'),
      formatIndexMd(this.metas),
      'utf-8'
    );
  }

  private async syncOneMd(cascadeId: string, config: ReturnType<typeof getConfig>, meta?: ConversationMeta) {
    try {
      if (!meta) {
        const summaries = await this.lsClient.getAllTrajectories();
        const s = summaries[cascadeId];
        if (!s) return;
        meta = this.toMeta(cascadeId, s);
      }

      const steps = await this.lsClient.getTrajectorySteps(cascadeId);
      if (steps.length === 0) return;

      const mdDir = path.join(config.backupDir, 'conversations_md', cascadeId);
      this.ensureDir(mdDir);
      fs.writeFileSync(path.join(mdDir, 'conversation.md'), formatConversationToMd(meta, steps), 'utf-8');
      fs.writeFileSync(path.join(mdDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf-8');
      this.out.appendLine(`[Sync] MD: ${meta.title} (${cascadeId.substring(0, 8)}…)`);
    } catch (e: any) {
      this.out.appendLine(`[Sync] MD export failed ${cascadeId.substring(0, 8)}…: ${e.message}`);
    }
  }

  // ── Helpers ──

  private toMeta(id: string, s: TrajectorySummary): ConversationMeta {
    return {
      cascadeId: id,
      title: s.summary || 'Untitled',
      createdTime: s.createdTime || '',
      lastModifiedTime: s.lastModifiedTime || '',
      stepCount: s.stepCount || 0,
      workspaces: (s.workspaces || []).map((w) => w.workspaceFolderAbsoluteUri || ''),
    };
  }

  private syncFiles(src: string, dest: string, ext: string) {
    if (!fs.existsSync(src)) return;
    this.ensureDir(dest);
    for (const f of fs.readdirSync(src).filter((f) => f.endsWith(ext))) {
      const s = path.join(src, f), d = path.join(dest, f);
      try {
        if (fs.existsSync(d) && fs.statSync(s).mtimeMs <= fs.statSync(d).mtimeMs) continue;
        fs.copyFileSync(s, d);
      } catch {}
    }
  }

  private syncDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(src)) return;
    this.ensureDir(dest);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dest, e.name);
      if (e.isDirectory()) { this.syncDirRecursive(s, d); }
      else {
        try {
          if (fs.existsSync(d) && fs.statSync(s).mtimeMs <= fs.statSync(d).mtimeMs) continue;
          this.ensureDir(path.dirname(d));
          fs.copyFileSync(s, d);
        } catch {}
      }
    }
  }

  private writeMeta(dir: string) {
    fs.writeFileSync(path.join(dir, '.ag-recover-meta.json'), JSON.stringify({
      version: '0.2.0',
      lastSyncTime: new Date().toISOString(),
      platform: process.platform,
      conversationCount: this.countPb(dir),
    }, null, 2), 'utf-8');
  }

  private countPb(dir: string): number {
    const d = path.join(dir, 'conversations');
    if (!fs.existsSync(d)) return 0;
    return fs.readdirSync(d).filter((f) => f.endsWith('.pb')).length;
  }

  private ensureDir(d: string) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  private gitInit(dir: string) {
    if (fs.existsSync(path.join(dir, '.git'))) return;
    try {
      require('child_process').execSync('git init', { cwd: dir, timeout: 5000 });
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!.gitignore\n', 'utf-8');
    } catch (e: any) { this.out.appendLine(`[Git] init failed: ${e.message}`); }
  }

  private gitCommit(dir: string, scope: string[]) {
    try {
      const { execSync } = require('child_process');
      for (const s of scope) {
        const p = path.join(dir, s);
        if (fs.existsSync(p)) execSync(`git add "${p}"`, { cwd: dir, timeout: 10000 });
      }
      const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8', timeout: 5000 });
      if (status.trim()) {
        execSync(`git commit -m "auto-backup ${new Date().toISOString()}"`, { cwd: dir, timeout: 10000 });
      }
    } catch {}
  }

  // ── 自检机制 ──

  /** L1 失败处理：累计失败 → 达阈值时弹窗告警 */
  private onL1Failure(detail: string) {
    this.consecutiveL1Failures++;
    this.out.appendLine(`[HEALTH] L1 failure #${this.consecutiveL1Failures}: ${detail}`);
    this.statusBar.setError(`Backup failed (${this.consecutiveL1Failures}x)`);

    if (this.consecutiveL1Failures >= SyncEngine.MAX_L1_FAILURES) {
      vscode.window.showErrorMessage(
        `⚠️ AG Recover: 核心备份连续失败 ${this.consecutiveL1Failures} 次！你的对话可能没有被备份。\n\n最近错误: ${detail}`,
        '查看日志',
        '重试同步'
      ).then((action) => {
        if (action === '查看日志') this.out.show();
        if (action === '重试同步') this.fullSync();
      });
    }
  }

  /** 定期健康检查 */
  private healthCheck() {
    const config = getConfig();
    const agPaths = getAGPaths();
    const issues: string[] = [];

    // 检查 1：备份目录是否可写
    try {
      const testFile = path.join(config.backupDir, '.health-check');
      fs.writeFileSync(testFile, Date.now().toString(), 'utf-8');
      fs.unlinkSync(testFile);
    } catch {
      issues.push('备份目录不可写');
    }

    // 检查 2：watcher 是否还活着（源目录是否存在）
    if (!fs.existsSync(agPaths.conversationsDir)) {
      issues.push('AG 对话目录不存在');
    }

    // 检查 3：距离上次成功 L1 是否超过 30 分钟
    if (this.lastSuccessfulL1) {
      const minsSinceLast = (Date.now() - this.lastSuccessfulL1.getTime()) / 60000;
      if (minsSinceLast > 30) {
        // 检查源目录是否有更新的文件（如果有但没被同步，说明 watcher 可能挂了）
        try {
          const pbFiles = fs.readdirSync(agPaths.conversationsDir).filter(f => f.endsWith('.pb'));
          for (const f of pbFiles) {
            const srcMtime = fs.statSync(path.join(agPaths.conversationsDir, f)).mtimeMs;
            const destPath = path.join(config.backupDir, 'conversations', f);
            if (!fs.existsSync(destPath) || fs.statSync(destPath).mtimeMs < srcMtime) {
              issues.push('检测到未同步的对话文件 — file watcher 可能失效');
              break;
            }
          }
        } catch {}
      }
    }

    if (issues.length > 0) {
      const msg = issues.join('；');
      this.out.appendLine(`[HEALTH] Issues detected: ${msg}`);
      this.statusBar.setError(issues[0]);
      vscode.window.showWarningMessage(
        `AG Recover 健康检查发现问题：${msg}`,
        '查看日志',
        '重试同步'
      ).then((action) => {
        if (action === '查看日志') this.out.show();
        if (action === '重试同步') this.fullSync();
      });
    } else {
      this.out.appendLine('[HEALTH] All checks passed');
    }
  }

  dispose() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
