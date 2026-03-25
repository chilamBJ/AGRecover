import * as https from 'https';
import { execSync } from 'child_process';
import * as os from 'os';

interface LSProcess {
  pid: number;
  csrfToken: string;
  port: number;
}

export interface TrajectorySummary {
  summary: string;
  stepCount: number;
  status: string;
  createdTime: string;
  lastModifiedTime: string;
  trajectoryId: string;
  workspaces: { workspaceFolderAbsoluteUri: string }[];
}

export class LSClient {
  private processes: LSProcess[] = [];
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  get isConnected(): boolean {
    return this.processes.length > 0;
  }

  /** 发现所有运行中的 LS 进程 */
  async discover(): Promise<boolean> {
    try {
      this.processes = [];
      const platform = os.platform();
      const psOutput = this.getPsOutput(platform);
      if (!psOutput) {
        this.log('[LS] No ps output');
        return false;
      }

      for (const line of psOutput.split('\n')) {
        if (!line.includes('language_server')) continue;
        if (line.includes('grep')) continue;

        const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (!csrfMatch) continue;

        const pidMatch = line.match(/^\s*\S+\s+(\d+)/);
        if (!pidMatch) continue;

        const pid = parseInt(pidMatch[1]);
        const csrfToken = csrfMatch[1];
        const ports = this.discoverPorts(pid, platform);
        this.log(`[LS] PID=${pid} candidate ports: [${ports.join(', ')}]`);

        // Probe 每个端口找到能响应 API 的那个
        for (const port of ports) {
          try {
            const ok = await this.probePort(port, csrfToken);
            if (ok) {
              this.processes.push({ pid, csrfToken, port });
              this.log(`[LS] ✓ PID=${pid} Port=${port} (API verified)`);
              break;
            }
          } catch {
            this.log(`[LS] ✗ Port ${port} no response`);
          }
        }
      }
      this.log(`[LS] Discovery done: ${this.processes.length} active LS`);
      return this.processes.length > 0;
    } catch (e: any) {
      this.log(`[LS] Discovery error: ${e.message}`);
      return false;
    }
  }

  /** Probe 端口是否能响应 API */
  private probePort(port: number, csrfToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: '127.0.0.1',
        port,
        path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken,
          'Content-Length': 2,
        },
        rejectUnauthorized: false,
        timeout: 3000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          resolve(data.includes('trajectorySummaries') || res.statusCode === 200);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write('{}');
      req.end();
    });
  }

  private getPsOutput(platform: string): string | null {
    try {
      if (platform === 'win32') {
        return execSync(
          'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'language_server*\' } | Select ProcessId,CommandLine | Format-List"',
          { encoding: 'utf-8', timeout: 10000 }
        );
      }
      return execSync('ps aux', { encoding: 'utf-8', timeout: 5000 });
    } catch {
      return null;
    }
  }

  /** 返回 LS 进程的所有 LISTEN 端口 */
  private discoverPorts(pid: number, platform: string): number[] {
    const ports: number[] = [];
    try {
      if (platform === 'win32') {
        const out = execSync(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`, {
          encoding: 'utf-8', timeout: 5000
        });
        for (const line of out.split('\n')) {
          const m = line.match(/:(\d+)\s/);
          if (m) ports.push(parseInt(m[1]));
        }
        return ports;
      }
      // macOS / Linux — 用 -a 确保 AND 过滤
      const out = execSync(`lsof -a -p ${pid} -i -P -n`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of out.split('\n')) {
        if (line.includes('LISTEN')) {
          const m = line.match(/:(\d+)\s/);
          if (m) ports.push(parseInt(m[1]));
        }
      }
    } catch (e: any) {
      this.log(`[LS] Port discovery failed PID=${pid}: ${e.message}`);
    }
    return ports;
  }

  /** 获取所有对话摘要 */
  async getAllTrajectories(): Promise<Record<string, TrajectorySummary>> {
    const results: Record<string, TrajectorySummary> = {};
    for (const proc of this.processes) {
      try {
        const data = await this.apiCall(proc, 'GetAllCascadeTrajectories', {});
        if (data?.trajectorySummaries) {
          Object.assign(results, data.trajectorySummaries);
        }
      } catch (e: any) {
        this.log(`[LS] GetTrajectories failed PID=${proc.pid}: ${e.message}`);
      }
    }
    return results;
  }

  /** 获取对话步骤 */
  async getTrajectorySteps(cascadeId: string): Promise<any[]> {
    for (const proc of this.processes) {
      try {
        const data = await this.apiCall(proc, 'GetCascadeTrajectorySteps', {
          cascadeId, startIndex: 0, endIndex: 1010,
        });
        if (data?.steps) return data.steps;
      } catch (e: any) {
        this.log(`[LS] GetSteps(${cascadeId.substring(0, 8)}…) failed: ${e.message}`);
      }
    }
    return [];
  }

  private apiCall(proc: LSProcess, method: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const req = https.request({
        hostname: '127.0.0.1',
        port: proc.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': proc.csrfToken,
          'Content-Length': Buffer.byteLength(postData),
        },
        rejectUnauthorized: false,
        timeout: method.includes('Steps') ? 30000 : 5000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Bad JSON: ${data.substring(0, 100)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(postData);
      req.end();
    });
  }
}
