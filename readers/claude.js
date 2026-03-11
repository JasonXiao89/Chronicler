const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

function normalizeClaudeUsage(usage) {
  if (!usage) return null;
  const cachedInput = (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const directInput = usage.input_tokens || 0;
  const input = directInput + cachedInput;
  const output = usage.output_tokens || 0;
  const reasoning = usage.reasoning_output_tokens || 0;
  const total = input + output;
  if (!input && !output && !reasoning) return null;
  return { input, output, total, cachedInput, reasoning };
}

function mergeTokenUsage(items) {
  let input = 0;
  let output = 0;
  let total = 0;
  let cachedInput = 0;
  let reasoning = 0;
  let hasAny = false;

  for (const item of items) {
    if (!item?.tokenUsage) continue;
    hasAny = true;
    input += item.tokenUsage.input || 0;
    output += item.tokenUsage.output || 0;
    total += item.tokenUsage.total || 0;
    cachedInput += item.tokenUsage.cachedInput || 0;
    reasoning += item.tokenUsage.reasoning || 0;
  }

  return hasAny ? { input, output, total, cachedInput, reasoning } : null;
}

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
      const toolResults = []; // outputs from tool_result blocks

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

      // If this is a user message with ONLY tool_result blocks (no user text),
      // attach the results to the preceding assistant message instead of creating an empty bubble
      const hasUserText = textParts.join('').trim().length > 0;
      const hasToolResults = toolResults.length > 0;
      const hasToolUses = toolUses.length > 0;

      if (entry.type === 'user' && hasToolResults && !hasUserText && !hasToolUses) {
        // Find preceding assistant message and attach results to its toolUses
        const prevAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        if (prevAssistant) {
          for (const result of toolResults) {
            // Match by tool_use_id if available, else append in order
            const matchingTool = prevAssistant.toolUses.find(t => t.id === result.id && !t.output);
            if (matchingTool) {
              matchingTool.output = result.output;
            } else {
              // Find first tool_use without output
              const unmatched = prevAssistant.toolUses.find(t => t.name !== '__result__' && !t.output);
              if (unmatched) unmatched.output = result.output;
            }
          }
        }
        continue; // Don't create an empty user bubble
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
        tokenUsage: normalizeClaudeUsage(entry.message?.usage),
      });
    } catch {
      // skip malformed lines
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

  const projects = fs.readdirSync(CLAUDE_DIR).filter(d =>
    fs.statSync(path.join(CLAUDE_DIR, d)).isDirectory()
  );

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

          // Strip system XML-like tags (e.g. <ide_opened_file>...</ide_opened_file>)
          const rawTitle = firstUser?.text || '(no title)';
          let cleanTitle = rawTitle
            .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, '')  // paired tags
            .replace(/<[a-z_-][^>]*\/>/g, '')                  // self-closing
            .replace(/<[a-z_-][^>]*>/g, '')                    // stray open tags
            .replace(/<\/[a-z_-]+>/g, '')                      // stray close tags
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
            tokenUsage: mergeTokenUsage(sorted),
          });
        }
      } catch {
        // skip unreadable files
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
