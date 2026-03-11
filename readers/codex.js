const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const SESSION_INDEX = path.join(CODEX_DIR, 'session_index.jsonl');

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadSessionIndex() {
  const entries = readJsonlFile(SESSION_INDEX);
  const index = {};
  for (const e of entries) {
    if (e.id) index[e.id] = e;
  }
  return index;
}

function extractUserText(rawMessage) {
  if (!rawMessage) return '';

  const marker = /##\s*My request for Codex:\s*\n([\s\S]+)/i;
  const m = rawMessage.match(marker);
  if (m) return m[1].trim();

  const stripped = rawMessage
    .replace(/^#\s*Context from my IDE setup:[\s\S]*?(?=\n[^#\n]|\n##)/m, '')
    .replace(/^##\s*Open tabs:[\s\S]*?(?=\n[^#\n]|\n##|\n$)/m, '')
    .trim();

  return stripped || rawMessage;
}

function parseSessionFile(filePath) {
  const entries = readJsonlFile(filePath);
  const messages = [];
  let meta = null;
  const toolCalls = new Map();

  function extractReasoningText(payload) {
    if (!payload) return '';
    if (typeof payload.content === 'string' && payload.content.trim()) return payload.content.trim();
    if (Array.isArray(payload.summary)) {
      const text = payload.summary
        .map(item => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.summary === 'string') return item.summary;
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
      if (text.trim()) return text.trim();
    }
    return '';
  }

  for (const entry of entries) {
    if (entry.type === 'session_meta') {
      meta = entry.payload;
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
      const text = extractUserText(entry.payload.message || '');
      if (text.trim()) {
        messages.push({
          role: 'user',
          text: text.trim(),
          timestamp: entry.timestamp,
        });
      }
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') {
      const phase = entry.payload.phase;
      const text = entry.payload.message || '';
      if (text.trim()) {
        messages.push({
          role: phase === 'final_answer' ? 'assistant' : 'thinking',
          text: text.trim(),
          timestamp: entry.timestamp,
          phase,
        });
      }
      continue;
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
      const text = extractReasoningText(entry.payload);
      if (text) {
        messages.push({
          role: 'thinking',
          text,
          timestamp: entry.timestamp,
          phase: 'reasoning',
        });
      }
      continue;
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      const input = (() => {
        try {
          return JSON.parse(entry.payload.arguments || '{}');
        } catch {
          return entry.payload.arguments || '';
        }
      })();
      const toolMsg = {
        role: 'tool',
        text: '',
        timestamp: entry.timestamp,
        toolName: entry.payload.name,
        toolInput: input,
        toolOutput: null,
        callId: entry.payload.call_id,
      };
      messages.push(toolMsg);
      if (entry.payload.call_id) toolCalls.set(entry.payload.call_id, toolMsg);
      continue;
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
      const output = entry.payload.output || '';
      const matchingTool = toolCalls.get(entry.payload.call_id);
      if (matchingTool) {
        matchingTool.toolOutput = output;
      } else if (output.trim()) {
        messages.push({
          role: 'tool',
          text: output.trim(),
          timestamp: entry.timestamp,
        });
      }
      continue;
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'web_search_call') {
      const action = entry.payload.action;
      const queries = action?.queries || (action?.query ? [action.query] : []);
      if (queries.length) {
        messages.push({
          role: 'tool',
          text: `Web search: ${queries.join(' | ')}`,
          timestamp: entry.timestamp,
        });
      }
    }
  }

  return { meta, messages };
}

function listAllSessionFiles() {
  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  }

  walk(SESSIONS_DIR);
  return files;
}

function listConversations() {
  if (!fs.existsSync(CODEX_DIR)) return [];

  const index = loadSessionIndex();
  const sessionFiles = listAllSessionFiles();
  const conversations = [];

  for (const filePath of sessionFiles) {
    try {
      const { meta, messages } = parseSessionFile(filePath);
      const realMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
      if (realMessages.length === 0) continue;

      const sessionId = meta?.id || path.basename(filePath, '.jsonl');
      const indexEntry = index[sessionId] || {};

      const firstUser = realMessages.find(m => m.role === 'user');
      const lastMsg = realMessages[realMessages.length - 1];

      conversations.push({
        id: `codex::${sessionId}`,
        source: 'codex',
        project: meta?.cwd || '',
        sessionId,
        file: filePath,
        title: indexEntry.thread_name || firstUser?.text?.slice(0, 100) || '(no title)',
        timestamp: meta?.timestamp || realMessages[0]?.timestamp || '',
        lastTimestamp: lastMsg?.timestamp || meta?.timestamp || '',
        messageCount: realMessages.length,
        model: meta?.model_provider,
      });
    } catch {
      // Skip unreadable sessions.
    }
  }

  return conversations.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
}

function getConversation(sessionId) {
  const sessionFiles = listAllSessionFiles();
  for (const filePath of sessionFiles) {
    if (filePath.includes(sessionId.slice(0, 8))) {
      const { messages } = parseSessionFile(filePath);
      return messages;
    }
  }
  return [];
}

module.exports = { listConversations, getConversation };
