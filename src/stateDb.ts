import * as fs from 'fs';
import * as path from 'path';

const BACKUP_KEYS = [
  'antigravityUnifiedStateSync.scratchWorkspaces',
  'antigravityUnifiedStateSync.sidebarWorkspaces',
  'antigravityUnifiedStateSync.trajectorySummaries',
  'antigravityUnifiedStateSync.modelPreferences',
  'antigravityUnifiedStateSync.agentPreferences',
  'antigravityUnifiedStateSync.tabPreferences',
  'antigravityUnifiedStateSync.theme',
  'antigravityUnifiedStateSync.windowPreferences',
  'antigravityUnifiedStateSync.editorPreferences',
  'history.recentlyOpenedPathsList',
];

const AUTH_KEYS = [
  'antigravityUnifiedStateSync.oauthToken',
  'antigravityAuthStatus',
  'vscode.github-authentication',
  'vscode.microsoft-authentication',
  'google.antigravity',
];

export interface StateBackup {
  timestamp: string;
  keys: Record<string, string>;
}

let sqlJsInstance: any = null;

async function getSqlJs(): Promise<any> {
  if (!sqlJsInstance) {
    const initSqlJs = require('sql.js');
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

/** 备份 state.vscdb 中的关键 key */
export async function backupStateKeys(stateDbPath: string, outputPath: string): Promise<void> {
  if (!fs.existsSync(stateDbPath)) return;

  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(stateDbPath);
  const db = new SQL.Database(buffer);

  try {
    const backup: StateBackup = { timestamp: new Date().toISOString(), keys: {} };

    for (const key of BACKUP_KEYS) {
      try {
        const result = db.exec(`SELECT value FROM ItemTable WHERE key = '${key}'`);
        if (result.length > 0 && result[0].values.length > 0) {
          backup.keys[key] = result[0].values[0][0] as string;
        }
      } catch { /* key may not exist */ }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(backup, null, 2), 'utf-8');
  } finally {
    db.close();
  }
}

/** 恢复 state.vscdb 中的 key，优先合并，可选全覆盖 */
export async function restoreStateKeys(
  stateDbPath: string,
  backupPath: string,
  mode: 'merge' | 'overwrite' = 'merge'
): Promise<{ restored: number; skipped: number; errors: string[] }> {
  const result = { restored: 0, skipped: 0, errors: [] as string[] };

  if (!fs.existsSync(backupPath)) {
    result.errors.push('Backup file not found');
    return result;
  }
  if (!fs.existsSync(stateDbPath)) {
    result.errors.push('state.vscdb not found');
    return result;
  }

  const backup: StateBackup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(stateDbPath);
  const db = new SQL.Database(buffer);

  try {
    for (const [key, value] of Object.entries(backup.keys)) {
      // 安全：绝不写 auth key
      if (AUTH_KEYS.some(ak => key.includes(ak))) {
        result.skipped++;
        continue;
      }

      try {
        if (mode === 'merge') {
          const existing = db.exec(`SELECT value FROM ItemTable WHERE key = '${key}'`);
          if (existing.length > 0 && existing[0].values.length > 0) {
            // trajectorySummaries 特殊处理：合并缺失的对话
            if (key === 'antigravityUnifiedStateSync.trajectorySummaries') {
              const existingVal = JSON.parse(existing[0].values[0][0] as string);
              const backupVal = JSON.parse(value);
              const merged = { ...backupVal, ...existingVal }; // 现有值优先
              db.run(`UPDATE ItemTable SET value = ? WHERE key = ?`, [JSON.stringify(merged), key]);
              result.restored++;
            } else {
              result.skipped++; // 已存在则跳过
            }
            continue;
          }
        }
        db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, [key, value]);
        result.restored++;
      } catch (e: any) {
        result.errors.push(`Key ${key}: ${e.message}`);
      }
    }

    // 写回文件
    const data = db.export();
    fs.writeFileSync(stateDbPath, Buffer.from(data));
  } finally {
    db.close();
  }

  return result;
}
