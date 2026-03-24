import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export interface AGRecoverConfig {
  backupDir: string;
  autoBackup: boolean;
  gitAutoCommit: boolean;
  gitScope: string[];
  mdSyncIntervalSeconds: number;
}

export function getConfig(): AGRecoverConfig {
  const cfg = vscode.workspace.getConfiguration('agRecover');
  const defaultBackupDir = path.join(os.homedir(), '.ag-recover');

  return {
    backupDir: cfg.get<string>('backupDir') || defaultBackupDir,
    autoBackup: cfg.get<boolean>('autoBackup', true),
    gitAutoCommit: cfg.get<boolean>('gitAutoCommit', false),
    gitScope: cfg.get<string[]>('gitScope', ['conversations_md', 'brain']),
    mdSyncIntervalSeconds: cfg.get<number>('mdSyncIntervalSeconds', 300),
  };
}

/** AG 数据路径（跨平台） */
export function getAGPaths() {
  const home = os.homedir();
  const platform = os.platform();

  const geminiDir = path.join(home, '.gemini');
  const agDir = path.join(geminiDir, 'antigravity');

  let appDataDir: string;
  if (platform === 'win32') {
    appDataDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'User');
  } else if (platform === 'darwin') {
    appDataDir = path.join(home, 'Library', 'Application Support', 'Antigravity', 'User');
  } else {
    appDataDir = path.join(home, '.config', 'Antigravity', 'User');
  }

  return {
    geminiDir,
    agDir,
    conversationsDir: path.join(agDir, 'conversations'),
    brainDir: path.join(agDir, 'brain'),
    userSettings: path.join(agDir, 'user_settings.pb'),
    globalRules: path.join(geminiDir, 'GEMINI.md'),
    appDataDir,
    globalStorageDir: path.join(appDataDir, 'globalStorage'),
    stateVscdb: path.join(appDataDir, 'globalStorage', 'state.vscdb'),
  };
}
