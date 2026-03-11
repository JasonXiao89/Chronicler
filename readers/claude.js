const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

function parseClaudeFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;

      const content = entry.message?.content || [];
      const textParts = [];
      const thinkingParts = [];
      const toolUses = [];
      const toolResults = [];

      for (const block of content) {
        if (block.type === 'text') textParts.push(block.text);
        if (block.type === 'thinking') thinkingParts.push(block.thinking);
        if (block.type === 'tool_use') toolUses.push({ name: block.name, input: block.input, id: block.id });
        if (block.type === 'tool_result') {
          let output = '';
          if (typeof block.content === 'string') output = block.content;
          else if (Array.isArray(block.content)) {
            output = block.content.map(c => c.text || c.content || '').join('\n');
          }
          toolResults.push({ id: block.tool_use_id, output: output.slice(0, 3000) });
        }
        if (typeof block === 'string') textParts.push(block);
        if (block.type === 'input_text') textParts.push(block.text);
      }

      const hasUserText = textParts.join('').trim().length > 0;
      const hasToolResults = toolResults.length > 0;
      const hasToolUses = toolUses.length > 0;

      if (entry.type === 'user' && hasToolResults && !hasUserText && !hasToolUses) {
        const prevAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        if (prevAssistant) {
          for (const result of toolResults) {
            const matchingTool = prevAssistant.toolUses.find(t => t.id === result.id && !t.output);
            if (matchingTool) {
              matchingTool.output = result.output;
            } else {
              const unmatched = prevAssistant.toolUses.find(t => t.name !== '__result__' && !t.output);
              if (unmatched) unmatched.output = result.output;
            }
          }
        }
        continue;
      }

      messages.push({
        uuid: entry.uuid,
        parentUuid: entry.parentUuid,
        sessionId: entry.sessionId,
        role: entry.type,
        timestamp: entry.timestamp,
        text: textParts.join('\n'),
        thinking: thinkingParts.join('\n'),
        toolUses,
        model: entry.message?.model,
      });
    } catch {
      // Skip malformed lines.
    }
  }

  return messages;
}

function groupIntoSessions(messages) {
  const sessions = {};
  for (const msg of messages) {
    const sid = msg.sessionId || 'unknown';
    if (!sessions[sid]) sessions[sid] = [];
    sessions[sid].push(msg);
  }
  return sessions;
}

function listConversations() {
  if (!fs.existsSync(CLAUDE_DIR)) return [];

  const projects = fs
    .readdirSync(CLAUDE_DIR)
    .filter(d => fs.statSync(path.join(CLAUDE_DIR, d)).isDirectory());

  const conversations = [];

  for (const project of projects) {
    const projectDir = path.join(CLAUDE_DIR, project);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      try {
        const messages = parseClaudeFile(filePath);
        if (messages.length === 0) continue;

        const sessions = groupIntoSessions(messages);

        for (const [sessionId, msgs] of Object.entries(sessions)) {
          const sorted = msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          const firstUser = sorted.find(m => m.role === 'user');
          const lastMsg = sorted[sorted.length - 1];

          const rawTitle = firstUser?.text || '(no title)';
          let cleanTitle = rawTitle
            .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, '')
            .replace(/<[a-z_-][^>]*\/>/g, '')
            .replace(/<[a-z_-][^>]*>/g, '')
            .replace(/<\/[a-z_-]+>/g, '')
            .trim();
          if (!cleanTitle) cleanTitle = '(no title)';

          conversations.push({
            id: `claude::${project}::${sessionId}`,
            source: 'claude',
            project: project.replace(/^C--/, 'C:/').replace(/--/g, '/'),
            sessionId,
            file: filePath,
            title: cleanTitle.slice(0, 100) || '(no title)',
            timestamp: sorted[0]?.timestamp || '',
            lastTimestamp: lastMsg?.timestamp || '',
            messageCount: sorted.length,
          });
        }
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return conversations.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
}

function getConversation(project, sessionId) {
  const projectDir = path.join(CLAUDE_DIR, project);
  const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(projectDir, file);
    const messages = parseClaudeFile(filePath);
    const sessions = groupIntoSessions(messages);
    if (sessions[sessionId]) {
      return sessions[sessionId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
  }
  return [];
}

module.exports = { listConversations, getConversation };
