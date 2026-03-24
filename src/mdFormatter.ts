export interface ConversationMeta {
  cascadeId: string;
  title: string;
  createdTime: string;
  lastModifiedTime: string;
  stepCount: number;
  workspaces: string[];
}

/** 将对话结构化数据格式化为 Markdown */
export function formatConversationToMd(meta: ConversationMeta, steps: any[]): string {
  const lines: string[] = [
    `# ${meta.title || 'Untitled Conversation'}`,
    '',
    `> Cascade ID: \`${meta.cascadeId}\`  `,
    `> Created: ${meta.createdTime}  `,
    `> Last Modified: ${meta.lastModifiedTime}  `,
    ...(meta.workspaces.length ? [`> Workspace: ${meta.workspaces.join(', ')}  `] : []),
    `> Steps: ${meta.stepCount}`,
    '', '---', '',
  ];

  for (const step of steps) {
    const formatted = formatStep(step);
    if (formatted) {
      lines.push(formatted, '', '---', '');
    }
  }
  return lines.join('\n');
}

function formatStep(step: any): string | null {
  const t = step.type || step.stepType;

  if (t === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
    return `## 👤 User\n\n${step.userInput.userResponse || ''}`;
  }

  if (t === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.plannerResponse) {
    let s = '## 🤖 Assistant\n\n';
    if (step.plannerResponse.thinking) {
      s += `<details>\n<summary>💭 Thinking</summary>\n\n${step.plannerResponse.thinking}\n\n</details>\n\n`;
    }
    s += step.plannerResponse.response || '';
    return s;
  }

  if (t === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.codeAction) {
    let s = `### 📝 Code Edit: ${step.codeAction.description || ''}\n\n`;
    if (step.codeAction.actionResult?.edit?.diff) {
      s += `\`\`\`diff\n${step.codeAction.actionResult.edit.diff}\n\`\`\``;
    }
    return s;
  }

  if (t === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
    let s = `### 🖥️ Command: \`${step.runCommand.commandLine || ''}\`\n\n`;
    if (step.runCommand.combinedOutput) {
      s += `\`\`\`\n${step.runCommand.combinedOutput}\n\`\`\``;
    }
    return s;
  }

  if (t === 'CORTEX_STEP_TYPE_VIEW_FILE' && step.viewFile) {
    return `### 📄 View File: \`${step.viewFile.absolutePathUri || ''}\``;
  }

  if (t === 'CORTEX_STEP_TYPE_FIND' && step.find) {
    return `### 🔍 Search: \`${step.find.query || ''}\``;
  }

  if (t === 'CORTEX_STEP_TYPE_LIST_DIRECTORY' && step.listDirectory) {
    return `### 📁 List Dir: \`${step.listDirectory.directoryPath || ''}\``;
  }

  if (t === 'CORTEX_STEP_TYPE_SEARCH_WEB' && step.searchWeb) {
    let s = `### 🌐 Web Search: \`${step.searchWeb.query || ''}\`\n\n`;
    if (step.searchWeb.summary) s += step.searchWeb.summary;
    return s;
  }

  if (t === 'CORTEX_STEP_TYPE_READ_URL_CONTENT' && step.readUrlContent) {
    return `### 🔗 Read URL: ${step.readUrlContent.url || ''}`;
  }

  return null; // 未知类型跳过
}

/** 生成对话索引 MD */
export function formatIndexMd(conversations: Map<string, ConversationMeta>): string {
  const lines: string[] = [
    '# AG Recover — Conversation Index',
    '',
    `> Updated: ${new Date().toISOString()}  `,
    `> Total: ${conversations.size} conversations`,
    '',
    '| Title | Created | Steps | Workspace |',
    '|-------|---------|-------|-----------|',
  ];

  const sorted = [...conversations.entries()].sort((a, b) =>
    (b[1].lastModifiedTime || '').localeCompare(a[1].lastModifiedTime || '')
  );

  for (const [id, m] of sorted) {
    lines.push(`| [${m.title || 'Untitled'}](./${id}/conversation.md) | ${m.createdTime?.substring(0, 10) || '-'} | ${m.stepCount} | ${m.workspaces[0] || '-'} |`);
  }
  return lines.join('\n');
}
