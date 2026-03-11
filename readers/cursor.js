const path = require('path');
const os = require('os');

const CURSOR_DB = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb'
);

let db = null;
let dbAvailable = false;

function initDb() {
  if (db !== null) return;
  try {
    const Database = require('better-sqlite3');
    db = new Database(CURSOR_DB, { readonly: true });
    dbAvailable = true;
  } catch (e) {
    console.warn('Cursor SQLite not available:', e.message);
    dbAvailable = false;
    db = false;
  }
}

function parseComposerData(row) {
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function listFromOldFormat(data, composerId) {
  const conversation = data.conversation || [];
  if (conversation.length < 2) return null;

  const firstUser = conversation.find(m => m.type === 1);
  const createdAt = data.createdAt ? new Date(data.createdAt).toISOString() : '';
  const lastUpdatedAt = data.lastUpdatedAt ? new Date(data.lastUpdatedAt).toISOString() : createdAt;
  const title = (firstUser?.text || '').trim().slice(0, 100) || '(no title)';

  return {
    id: `cursor::${composerId}`,
    source: 'cursor',
    project: data.context?.currentFile || '',
    sessionId: composerId,
    title,
    timestamp: createdAt,
    lastTimestamp: lastUpdatedAt,
    messageCount: conversation.filter(m => m.type === 1 || m.type === 2).length,
    status: data.status,
    _format: 'old',
  };
}

function getFromOldFormat(data) {
  return (data.conversation || [])
    .filter(m => m.type === 1 || m.type === 2)
    .map(m => ({
      role: m.type === 1 ? 'user' : 'assistant',
      text: m.text || '',
      timestamp: '',
      isAgentic: m.isAgentic || false,
      codeBlocks: m.codeBlocks || [],
      relevantFiles: m.relevantFiles || [],
      webReferences: m.webReferences || [],
    }));
}

function fetchBubble(composerId, bubbleId) {
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${composerId}:${bubbleId}`);
    if (!row) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function parseJsonSafe(value) {
  if (!value || typeof value !== 'string') return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getThinkingText(bubble) {
  const thinking = bubble?.thinking;
  if (!thinking) return '';
  if (typeof thinking === 'string') return thinking.trim();
  if (Array.isArray(thinking)) {
    return thinking
      .map(item => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof thinking === 'object') {
    if (typeof thinking.text === 'string') return thinking.text.trim();
    try {
      return JSON.stringify(thinking, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

function extractAgentStepMessages(bubble) {
  const steps = [];
  const thinkingText = getThinkingText(bubble);
  if (thinkingText) {
    steps.push({
      role: 'thinking',
      text: thinkingText,
      timestamp: bubble.createdAt || '',
      source: 'cursor',
    });
  }

  const tool = bubble?.toolFormerData;
  if (tool?.name) {
    const rawArgs = parseJsonSafe(tool.rawArgs);
    const params = parseJsonSafe(tool.params);
    const result = parseJsonSafe(tool.result);
    const additionalData = parseJsonSafe(tool.additionalData);
    const toolDescription = params?.commandDescription || rawArgs?.commandDescription || '';

    steps.push({
      role: 'tool',
      text: '',
      timestamp: bubble.createdAt || '',
      source: 'cursor',
      toolName: tool.name,
      toolDescription,
      toolStatus: tool.status || additionalData?.status || '',
      toolInput: rawArgs || params || null,
      toolOutput: result || additionalData || null,
    });
  }

  return steps;
}

function listFromNewFormat(data, composerId) {
  const headers = data.fullConversationHeadersOnly || [];
  if (headers.length < 2) return null;

  let title = data.name || '(no title)';
  if (!title || title === '(no title)') {
    const firstUserHeader = headers.find(h => h.type === 1);
    if (firstUserHeader) {
      const bubble = fetchBubble(composerId, firstUserHeader.bubbleId);
      if (bubble?.text) title = bubble.text.trim().slice(0, 100);
    }
  }

  const createdAt = data.createdAt ? new Date(data.createdAt).toISOString() : '';
  const lastUpdatedAt = data.lastUpdatedAt ? new Date(data.lastUpdatedAt).toISOString() : createdAt;
  const userCount = headers.filter(h => h.type === 1).length;

  return {
    id: `cursor::${composerId}`,
    source: 'cursor',
    project: data.context?.currentFile || '',
    sessionId: composerId,
    title: title || '(no title)',
    timestamp: createdAt,
    lastTimestamp: lastUpdatedAt,
    messageCount: userCount * 2,
    status: data.status,
    _format: 'new',
  };
}

function getFromNewFormat(data, composerId) {
  const headers = data.fullConversationHeadersOnly || [];
  const messages = [];
  let agentStepCount = 0;

  for (const h of headers) {
    const bubble = fetchBubble(composerId, h.bubbleId);
    if (!bubble) continue;

    const role = h.type === 1 ? 'user' : 'assistant';
    const text = bubble.text || '';

    if (role === 'user') {
      if (agentStepCount > 0) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') {
          last._agentSteps = agentStepCount;
        }
        agentStepCount = 0;
      }
      if (text) {
        messages.push({
          role: 'user',
          text,
          timestamp: bubble.createdAt || '',
          isAgentic: false,
          codeBlocks: [],
          relevantFiles: bubble.relevantFiles || [],
          webReferences: bubble.webReferences || [],
        });
      }
    } else {
      if (!text) {
        messages.push(...extractAgentStepMessages(bubble));
        agentStepCount++;
      } else {
        messages.push({
          role: 'assistant',
          text,
          timestamp: bubble.createdAt || '',
          isAgentic: bubble.isAgentic || false,
          codeBlocks: [],
          relevantFiles: [],
          webReferences: bubble.webReferences || [],
          _agentSteps: agentStepCount,
        });
        agentStepCount = 0;
      }
    }
  }
  return messages;
}

function listConversations() {
  initDb();
  if (!dbAvailable) return [];

  try {
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all();

    const conversations = [];

    for (const row of rows) {
      const data = parseComposerData(row);
      if (!data) continue;

      const composerId = data.composerId || row.key.replace('composerData:', '');

      let entry = null;
      if (data.conversation && data.conversation.length >= 2) {
        entry = listFromOldFormat(data, composerId);
      } else if (data.fullConversationHeadersOnly && data.fullConversationHeadersOnly.length >= 2) {
        entry = listFromNewFormat(data, composerId);
      }

      if (entry) conversations.push(entry);
    }

    return conversations.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
  } catch (e) {
    console.error('Error reading Cursor conversations:', e.message);
    return [];
  }
}

function getConversation(sessionId) {
  initDb();
  if (!dbAvailable) return [];

  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${sessionId}`);

    if (!row) return [];

    const data = parseComposerData(row);
    if (!data) return [];

    if (data.conversation && data.conversation.length > 0) {
      return getFromOldFormat(data);
    }
    if (data.fullConversationHeadersOnly && data.fullConversationHeadersOnly.length > 0) {
      return getFromNewFormat(data, sessionId);
    }
    return [];
  } catch (e) {
    console.error('Error fetching Cursor conversation:', e.message);
    return [];
  }
}

module.exports = { listConversations, getConversation };
