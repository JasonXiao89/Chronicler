const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const claudeReader = require('./readers/claude');
const codexReader = require('./readers/codex');
const cursorReader = require('./readers/cursor');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求内容过大，请减少消息体积后再试' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: '请求 JSON 格式无效' });
  }
  return next(err);
});

// Prefer Anthropic API key, fallback to OpenAI key
let aiProvider = null;

function loadAiProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    return {
      type: 'anthropic',
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    };
  }

  let openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    const desktopConfig = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Claude',
      'claude_desktop_config.json'
    );
    if (fs.existsSync(desktopConfig)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(desktopConfig, 'utf8'));
        const text = JSON.stringify(cfg);
        const m = text.match(/"OPENAI_API_KEY":"([^"]+)"/);
        if (m) openaiKey = m[1];
      } catch {}
    }
  }

  if (openaiKey) {
    return { type: 'openai', key: openaiKey };
  }

  return null;
}

aiProvider = loadAiProvider();
console.log(
  'AI provider:',
  aiProvider?.type || 'none (set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env)'
);

let cache = { conversations: null, lastLoaded: 0 };
const CACHE_TTL = 5 * 60 * 1000;

function getAllConversations(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.conversations && now - cache.lastLoaded < CACHE_TTL) {
    return cache.conversations;
  }

  console.log('Loading all conversations...');
  const [claude, codex, cursor] = [
    claudeReader.listConversations(),
    codexReader.listConversations(),
    cursorReader.listConversations(),
  ];

  const all = [...claude, ...codex, ...cursor].sort(
    (a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp)
  );

  cache = { conversations: all, lastLoaded: now };
  console.log(`Loaded: ${claude.length} Claude, ${codex.length} Codex, ${cursor.length} Cursor`);
  return all;
}

app.get('/api/conversations', (req, res) => {
  try {
    const { source, q, page = 1, limit = 50 } = req.query;
    let conversations = getAllConversations(req.query.refresh === '1');

    if (source && source !== 'all') {
      conversations = conversations.filter(c => c.source === source);
    }

    if (q) {
      const lower = q.toLowerCase();
      conversations = conversations.filter(
        c => c.title?.toLowerCase().includes(lower) || c.project?.toLowerCase().includes(lower)
      );
    }

    const total = conversations.length;
    const start = (page - 1) * limit;
    const items = conversations.slice(start, start + parseInt(limit, 10));

    res.json({ total, page: parseInt(page, 10), limit: parseInt(limit, 10), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/conversations/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const parts = id.split('::');
    const source = parts[0];

    let messages = [];

    if (source === 'claude') {
      const [, project, sessionId] = parts;
      messages = claudeReader.getConversation(project, sessionId);
    } else if (source === 'codex') {
      const [, sessionId] = parts;
      messages = codexReader.getConversation(sessionId);
    } else if (source === 'cursor') {
      const [, sessionId] = parts;
      messages = cursorReader.getConversation(sessionId);
    }

    res.json({ id, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const all = getAllConversations();
    const bySource = {};
    for (const c of all) {
      bySource[c.source] = (bySource[c.source] || 0) + 1;
    }
    res.json({ total: all.length, bySource });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function clipText(value, limit = 400) {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value, null, 2);
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}\n...[truncated]`
    : normalized;
}

function summarizeArray(items, mapper, limit = 5) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .slice(0, limit)
    .map(mapper)
    .filter(Boolean)
    .join(', ');
}

function formatSummaryMessage(message) {
  const text = message.text || message.content || '';

  if (message.role === 'user') {
    return `User:\n${clipText(text, 1600)}`;
  }

  if (message.role === 'assistant') {
    const parts = [];
    if (message.thinking) parts.push(`[Embedded thinking]\n${clipText(message.thinking, 600)}`);
    if (message.toolUses?.length) {
      parts.push(`[Declared tools] ${message.toolUses.map(t => t.name).join(', ')}`);
    }
    if (message.relevantFiles?.length) {
      parts.push(
        `[Relevant files] ${summarizeArray(
          message.relevantFiles,
          f => {
            const raw = f?.uri?.path || f?.path || f;
            return typeof raw === 'string' ? raw.split(/[/\\]/).pop() : '';
          },
          8
        )}`
      );
    }
    if (message.webReferences?.length) {
      parts.push(`[Web refs] ${summarizeArray(message.webReferences, r => r.title || r.url, 6)}`);
    }
    return `Assistant${parts.length ? `\n${parts.join('\n')}` : ''}\n${clipText(text, 1600)}`;
  }

  if (message.role === 'thinking') {
    return `Thinking:\n${clipText(text, 1200)}`;
  }

  if (message.role === 'tool') {
    const parts = [];
    const label = message.toolName || message.name || 'tool';
    const description = message.toolDescription ? ` - ${message.toolDescription}` : '';
    parts.push(`Tool ${label}${description}`);
    if (message.toolStatus) parts.push(`[Status] ${message.toolStatus}`);
    if (message.toolInput) parts.push(`[Input]\n${clipText(message.toolInput, 1200)}`);
    if (message.toolOutput) parts.push(`[Output]\n${clipText(message.toolOutput, 1200)}`);
    if (!message.toolInput && !message.toolOutput && text) {
      parts.push(clipText(text, 800));
    }
    return parts.join('\n');
  }

  return '';
}

app.post('/api/summarize', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { messages, title, source } = req.body;

    if (!messages || messages.length === 0) {
      res.write(`data: ${JSON.stringify({ error: 'No messages provided' })}\n\n`);
      return res.end();
    }

    const convText = messages
      .filter(m => ['user', 'assistant', 'thinking', 'tool'].includes(m.role))
      .slice(0, 120)
      .map(formatSummaryMessage)
      .filter(Boolean)
      .join('\n\n---\n\n');

    const systemPrompt = `你是一个对话分析专家。你的首要目标不是“压缩成结论”，而是尽可能保留这次对话里与以下内容相关的关键线索：

- 用户的真实目标、约束、偏好与隐含诉求
- 用户意图在对话中的变化
- Agent 的思考、判断、策略、执行逻辑与取舍
- Agent 如何通过工具、验证、报错、修复、重试来推进问题
- 关键转折点：误判、发现、修正、验证、最终确认

请特别注意：
- 不要只总结最终答案，要总结“如何到达答案”
- 如果对话中出现 thinking、tool、command description、tool output、验证步骤，这些都应被视为重要证据
- 如果用户意图有多阶段变化，请明确写出“先想做什么，后来又补充/转向了什么”
- 如果 Agent 采用了具体策略，例如先排查、再验证、再修改、再重启、再复测，要按时间顺序保留
- 如果某些思考/策略线索不充分，要明确说明“可见证据显示”而不要编造

请用中文输出，格式如下（使用 Markdown）：

## 问题背景

## 用户意图 (Intent)

## 意图演化

## Agent 的思路与判断

## 策略与执行路径

## 关键决策与转折点

## 解决方案与结果

## 核心洞察

## 标签`;

    if (!aiProvider) {
      res.write(
        `data: ${JSON.stringify({ error: '未配置 AI API Key。请在 .env 文件中设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY' })}\n\n`
      );
      return res.end();
    }

    const userPrompt = `请分析以下对话：\n\n**来源**: ${source}\n**标题**: ${title}\n\n${convText}`;

    if (aiProvider.type === 'anthropic') {
      const stream = await aiProvider.client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
    } else if (aiProvider.type === 'openai') {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiProvider.key}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 2200,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      const reader = openaiRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const d = JSON.parse(line.slice(6));
            const text = d.choices?.[0]?.delta?.content;
            if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
          } catch {}
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

const SUMMARIES_DIR = path.join(__dirname, 'summaries');
if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR);

function summaryFile(id) {
  return path.join(SUMMARIES_DIR, id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md');
}

app.get('/api/summaries/:id', (req, res) => {
  const file = summaryFile(decodeURIComponent(req.params.id));
  if (!fs.existsSync(file)) return res.json({ text: null });
  res.json({ text: fs.readFileSync(file, 'utf8') });
});

app.post('/api/summaries/:id', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'no text' });
  fs.writeFileSync(summaryFile(decodeURIComponent(req.params.id)), text, 'utf8');
  res.json({ ok: true });
});

app.get('/api/debug/cursor/:sessionId', (req, res) => {
  try {
    const msgs = cursorReader.getConversation(req.params.sessionId);
    res.json(
      msgs.slice(0, 3).map(m => ({
        role: m.role,
        text: m.text?.slice(0, 100),
        codeBlocksCount: m.codeBlocks?.length,
        codeBlockSample: m.codeBlocks?.[0],
        relevantFilesCount: m.relevantFiles?.length,
        relevantFileSample: m.relevantFiles?.[0],
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3738;
app.listen(PORT, () => {
  console.log(`\nChronicler running at http://localhost:${PORT}\n`);
  setTimeout(() => getAllConversations(), 500);
});
