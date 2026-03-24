import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getAGPaths } from './config';
import { LSClient } from './lsClient';

interface InjectCandidate {
  cascadeId: string;
  title: string;
  lastModified: string;
  hasMd: boolean;
  alreadyInNative: boolean;
}

/**
 * 选择性注入：用户从备份中选一个对话 →
 * 只复制那一个 .pb → LS 强制加载 → 原生历史列表中出现
 * 不碰 state.vscdb，不需要重启
 */
export async function injectConversation(
  lsClient: LSClient,
  out: vscode.OutputChannel
) {
  const config = getConfig();
  const agPaths = getAGPaths();
  const backupConvDir = path.join(config.backupDir, 'conversations');

  if (!fs.existsSync(backupConvDir)) {
    vscode.window.showErrorMessage('AG Recover: 没有备份数据。');
    return;
  }

  // 列出所有备份的 .pb 文件
  const pbFiles = fs.readdirSync(backupConvDir).filter((f) => f.endsWith('.pb'));
  if (pbFiles.length === 0) {
    vscode.window.showErrorMessage('AG Recover: 备份中没有对话文件。');
    return;
  }

  // 检查哪些已经在原生目录中
  const nativeIds = new Set<string>();
  if (fs.existsSync(agPaths.conversationsDir)) {
    for (const f of fs.readdirSync(agPaths.conversationsDir).filter((f) => f.endsWith('.pb'))) {
      nativeIds.add(f.replace('.pb', ''));
    }
  }

  // 构建候选列表
  const candidates: InjectCandidate[] = [];
  for (const f of pbFiles) {
    const id = f.replace('.pb', '');
    const stat = fs.statSync(path.join(backupConvDir, f));

    // 尝试从 MD metadata 获取标题
    let title = id.substring(0, 12) + '…';
    const metaPath = path.join(config.backupDir, 'conversations_md', id, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        title = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).title || title;
      } catch {}
    }

    candidates.push({
      cascadeId: id,
      title,
      lastModified: stat.mtime.toISOString(),
      hasMd: fs.existsSync(path.join(config.backupDir, 'conversations_md', id, 'conversation.md')),
      alreadyInNative: nativeIds.has(id),
    });
  }

  // 按最后修改时间排序
  candidates.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  // Quick Pick — 区分已存在和未存在的
  const items = candidates.map((c) => {
    const status = c.alreadyInNative ? '$(check) 已在AG中' : '$(cloud-download) 可注入';
    return {
      label: `${c.alreadyInNative ? '✅' : '📥'} ${c.title}`,
      description: status,
      detail: `ID: ${c.cascadeId.substring(0, 8)}… | ${new Date(c.lastModified).toLocaleString()}`,
      _candidate: c,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要注入到 AG 原生历史的对话（不碰 state.vscdb，不需重启）',
    canPickMany: true,
  });

  if (!picked || picked.length === 0) return;

  const toInject = picked.map((p) => (p as any)._candidate as InjectCandidate);
  const newOnes = toInject.filter((c) => !c.alreadyInNative);
  const existingOnes = toInject.filter((c) => c.alreadyInNative);

  // 确认
  let confirmMsg = `即将注入 ${toInject.length} 个对话`;
  if (existingOnes.length > 0) {
    confirmMsg += `\n（其中 ${existingOnes.length} 个已存在，将覆盖 .pb 文件）`;
  }

  const confirm = await vscode.window.showInformationMessage(
    confirmMsg,
    { modal: true, detail: '仅复制 .pb 文件到 AG 对话目录，通过 LS API 强制加载。不修改 state.vscdb，不需要重启。' },
    '确认注入',
    '取消'
  );

  if (confirm !== '确认注入') return;

  // 执行注入
  fs.mkdirSync(agPaths.conversationsDir, { recursive: true });
  let injected = 0;
  let lsLoaded = 0;

  // 确保 LS 可用
  const lsOk = lsClient.isConnected || (await lsClient.discover());

  for (const c of toInject) {
    try {
      // Step 1: 复制 .pb 文件
      const src = path.join(backupConvDir, `${c.cascadeId}.pb`);
      const dest = path.join(agPaths.conversationsDir, `${c.cascadeId}.pb`);
      fs.copyFileSync(src, dest);
      injected++;
      out.appendLine(`[Inject] Copied: ${c.title} (${c.cascadeId.substring(0, 8)}…)`);

      // Step 2: 通过 LS 强制加载（请求 1 步即可触发加载）
      if (lsOk) {
        try {
          await lsClient.getTrajectorySteps(c.cascadeId);
          lsLoaded++;
          out.appendLine(`[Inject] LS loaded: ${c.title}`);
        } catch (e: any) {
          out.appendLine(`[Inject] LS load failed (will appear after AG restart): ${e.message}`);
        }
      }

      // Step 3: 如果有 brain artifacts，也复制过去
      const backupBrainDir = path.join(config.backupDir, 'brain', c.cascadeId);
      if (fs.existsSync(backupBrainDir)) {
        const targetBrainDir = path.join(agPaths.brainDir, c.cascadeId);
        copyDirRecursive(backupBrainDir, targetBrainDir);
        out.appendLine(`[Inject] Brain artifacts restored for: ${c.title}`);
      }
    } catch (e: any) {
      out.appendLine(`[Inject] Failed ${c.cascadeId.substring(0, 8)}…: ${e.message}`);
    }
  }

  // 结果
  let resultMsg = `✅ 注入完成：${injected} 个对话已复制`;
  if (lsOk) {
    resultMsg += `，${lsLoaded} 个已被 LS 即时加载`;
    if (lsLoaded < injected) {
      resultMsg += `\n\n未被即时加载的对话将在 AG 重启后可见。`;
    } else {
      resultMsg += `\n\n现在点击 AG 的历史按钮就能看到了。`;
    }
  } else {
    resultMsg += `\n\nLS 未运行，重启 AG 后对话将可见。`;
  }

  vscode.window.showInformationMessage(resultMsg);
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
