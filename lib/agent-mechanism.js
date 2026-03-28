function normalizeText(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return String(value).trim();
  }
}

function clipText(value, limit = 180) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function inferSource(conversationId, source, messages) {
  if (source) return source;
  if (typeof conversationId === 'string' && conversationId.includes('::')) {
    return conversationId.split('::')[0];
  }
  const hinted = messages.find(message => message?.source);
  return hinted?.source || 'unknown';
}

function pushSegment(store, kind, payload) {
  const segment = {
    index: store.sequence.length,
    kind,
    role: payload.role || kind,
    embedded: Boolean(payload.embedded),
    label: payload.label || kind,
    preview: clipText(payload.preview),
    timestamp: payload.timestamp || '',
    messageIndex: Number.isInteger(payload.messageIndex) ? payload.messageIndex : null,
    meta: payload.meta || {},
  };
  store.sequence.push(segment);
  store[kind].push(segment);
  if (segment.embedded) {
    if (kind === 'thinking') store.embeddedThinking.push(segment);
    if (kind === 'tool') store.embeddedTools.push(segment);
  }
  return segment;
}

function buildTransitions(sequence) {
  const counts = new Map();
  for (let index = 0; index < sequence.length - 1; index += 1) {
    const from = sequence[index]?.kind;
    const to = sequence[index + 1]?.kind;
    if (!from || !to) continue;
    const key = `${from}->${to}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

function buildRatios(counts) {
  const total = counts.totalSegments || 0;
  const safeRatio = value => total ? Number((value / total).toFixed(3)) : 0;
  return {
    thinking: safeRatio(counts.thinking),
    tool: safeRatio(counts.tool),
    commentary: safeRatio(counts.commentary),
    final: safeRatio(counts.final),
    embeddedThinking: safeRatio(counts.embeddedThinking),
    embeddedTools: safeRatio(counts.embeddedTools),
  };
}

function classifyConversation(source, counts) {
  const labels = [];
  if (counts.thinking > 0) labels.push('显式推理型');
  if (counts.tool >= Math.max(2, counts.final)) labels.push('受控执行型');
  if (source === 'cursor') labels.push('环境耦合型');
  if (labels.length === 0 && counts.final > 0) labels.push('结果输出型');
  return labels;
}

function buildPatterns(source, sequence, transitions, counts) {
  const kinds = sequence.map(segment => segment.kind);
  const dedupedFlow = kinds.filter((kind, index) => kind !== kinds[index - 1]);
  const patterns = [];

  if (dedupedFlow.length) {
    const shortenedFlow = dedupedFlow.length > 12
      ? [...dedupedFlow.slice(0, 12), '...', dedupedFlow[dedupedFlow.length - 1]]
      : dedupedFlow;
    patterns.push(`典型流程: ${shortenedFlow.join(' -> ')}`);
  }

  const topTransition = transitions[0];
  if (topTransition) {
    patterns.push(`高频切换: ${topTransition.from} -> ${topTransition.to} (${topTransition.count})`);
  }

  if (counts.embeddedThinking || counts.embeddedTools) {
    patterns.push('存在嵌入 assistant 气泡的机制片段');
  }

  if (source === 'codex' && counts.thinking === 0 && counts.commentary > 0) {
    patterns.push('可见 reasoning 有限，更多通过阶段事件推断执行过程');
  }

  if (source === 'cursor' && counts.tool > 0 && counts.final > 0) {
    patterns.push('agent 步骤与最终回答分离，适合观察 IDE 内执行轨迹');
  }

  return patterns;
}

function buildSummary(source, counts, transitions, labels) {
  const visibleThinkingMode = counts.thinking > 0
    ? (counts.embeddedThinking > 0 ? '混合可见推理' : '显式推理')
    : '推理大多不可见';
  const topTransition = transitions[0];
  const dominantPattern = topTransition
    ? `${topTransition.from} -> ${topTransition.to}`
    : (counts.final > 0 ? 'single final response' : 'no stable pattern');

  return {
    source,
    labels,
    dominantPattern,
    visibleThinkingMode,
    confidence: source === 'cursor' && counts.thinking === 0 && counts.tool === 0
      ? 'low'
      : 'medium',
  };
}

function addSourceNotes(source, messages, counts, segments) {
  const notes = [];

  if (source === 'claude') {
    if (counts.embeddedThinking > 0 || counts.embeddedTools > 0) {
      notes.push({
        level: 'info',
        text: 'Claude 会把 thinking 和 tool_use 挂在 assistant 消息上，这里已拆成可分析段落。',
      });
    }
  }

  if (source === 'codex') {
    const hasEncryptedHint = messages.some(message =>
      message?.phase && message.role === 'thinking' && !normalizeText(message.text)
    );
    notes.push({
      level: 'warning',
      text: 'Codex 的部分 reasoning 可能只存在于 encrypted_content 或外围控制事件里，无法直接展开全文。',
    });
    if (!counts.thinking && (counts.commentary > 0 || counts.tool > 0 || hasEncryptedHint)) {
      notes.push({
        level: 'info',
        text: '当前会话主要依据 phase、tool 事件和可见 agent_message 推断执行机制。',
      });
    }
  }

  if (source === 'cursor') {
    const oldFormat = !messages.some(message =>
      message.role === 'thinking' ||
      message.role === 'tool' ||
      Number(message._agentSteps) > 0
    );
    if (oldFormat) {
      notes.push({
        level: 'warning',
        text: '这是 Cursor 旧格式会话，缺少完整 agent steps，机制分析置信度较低。',
      });
    } else {
      notes.push({
        level: 'info',
        text: 'Cursor 新格式会把 thinking、toolFormerData 和最终回答拆成多个 bubble，适合观察执行流。',
      });
    }
  }

  if (counts.final === 0 && segments.commentary.length > 0) {
    notes.push({
      level: 'warning',
      text: '未识别到稳定 final 段，当前以最后一个主要 assistant 输出作为近似终结段。',
    });
  }

  return notes;
}

function analyzeAssistantText(message, index, assistantTextIndexes, store) {
  const text = normalizeText(message.text || message.content);
  if (!text) return;

  const isFinal = index === assistantTextIndexes[assistantTextIndexes.length - 1];
  pushSegment(store, isFinal ? 'final' : 'commentary', {
    role: 'assistant',
    timestamp: message.timestamp,
    messageIndex: index,
    preview: text,
    label: isFinal ? 'final assistant' : 'assistant commentary',
    meta: {
      phase: message.phase || null,
      isAgentic: Boolean(message.isAgentic),
      agentSteps: Number(message._agentSteps || 0),
    },
  });
}

function analyzeClaudeMessage(message, index, assistantTextIndexes, store) {
  if (normalizeText(message.thinking)) {
    pushSegment(store, 'thinking', {
      role: 'assistant',
      embedded: true,
      timestamp: message.timestamp,
      messageIndex: index,
      preview: message.thinking,
      label: 'embedded thinking',
    });
  }

  if (Array.isArray(message.toolUses)) {
    for (const tool of message.toolUses) {
      pushSegment(store, 'tool', {
        role: 'assistant',
        embedded: true,
        timestamp: message.timestamp,
        messageIndex: index,
        preview: tool?.output || tool?.input || tool?.name,
        label: tool?.name || 'tool_use',
        meta: {
          name: tool?.name || '',
          input: tool?.input ?? null,
          output: tool?.output ?? null,
        },
      });
    }
  }

  analyzeAssistantText(message, index, assistantTextIndexes, store);
}

function analyzeCodexMessage(message, index, assistantTextIndexes, store) {
  if (message.role === 'thinking') {
    const kind = message.phase === 'reasoning' ? 'thinking' : 'commentary';
    pushSegment(store, kind, {
      role: 'thinking',
      timestamp: message.timestamp,
      messageIndex: index,
      preview: message.text,
      label: message.phase || kind,
      meta: { phase: message.phase || null },
    });
    return;
  }

  if (message.role === 'tool') {
    pushSegment(store, 'tool', {
      role: 'tool',
      timestamp: message.timestamp,
      messageIndex: index,
      preview: message.toolOutput || message.toolInput || message.text || message.toolName,
      label: message.toolName || 'tool',
      meta: {
        name: message.toolName || '',
        input: message.toolInput ?? null,
        output: message.toolOutput ?? null,
        status: message.toolStatus || '',
      },
    });
    return;
  }

  if (message.role === 'assistant') {
    analyzeAssistantText(message, index, assistantTextIndexes, store);
  }
}

function analyzeCursorMessage(message, index, assistantTextIndexes, store) {
  if (message.role === 'thinking') {
    pushSegment(store, 'thinking', {
      role: 'thinking',
      timestamp: message.timestamp,
      messageIndex: index,
      preview: message.text,
      label: 'thinking bubble',
    });
    return;
  }

  if (message.role === 'tool') {
    pushSegment(store, 'tool', {
      role: 'tool',
      timestamp: message.timestamp,
      messageIndex: index,
      preview: message.toolOutput || message.toolInput || message.text || message.toolName,
      label: message.toolName || 'tool bubble',
      meta: {
        name: message.toolName || '',
        input: message.toolInput ?? null,
        output: message.toolOutput ?? null,
        status: message.toolStatus || '',
      },
    });
    return;
  }

  if (message.role === 'assistant') {
    analyzeAssistantText(message, index, assistantTextIndexes, store);
  }
}

function analyzeConversationMechanism(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const source = inferSource(input.conversationId, input.source, messages);
  const assistantTextIndexes = messages
    .map((message, index) => normalizeText(message?.text) && message.role === 'assistant' ? index : -1)
    .filter(index => index >= 0);

  const segments = {
    sequence: [],
    thinking: [],
    tool: [],
    commentary: [],
    final: [],
    embeddedThinking: [],
    embeddedTools: [],
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === 'user') continue;

    if (source === 'claude') {
      analyzeClaudeMessage(message, index, assistantTextIndexes, segments);
      continue;
    }
    if (source === 'codex') {
      analyzeCodexMessage(message, index, assistantTextIndexes, segments);
      continue;
    }
    if (source === 'cursor') {
      analyzeCursorMessage(message, index, assistantTextIndexes, segments);
      continue;
    }

    if (message.role === 'thinking') {
      pushSegment(segments, 'thinking', {
        role: 'thinking',
        timestamp: message.timestamp,
        messageIndex: index,
        preview: message.text,
      });
    } else if (message.role === 'tool') {
      pushSegment(segments, 'tool', {
        role: 'tool',
        timestamp: message.timestamp,
        messageIndex: index,
        preview: message.toolOutput || message.toolInput || message.text,
        label: message.toolName || 'tool',
      });
    } else if (message.role === 'assistant') {
      analyzeAssistantText(message, index, assistantTextIndexes, segments);
    }
  }

  if (!segments.final.length && segments.commentary.length) {
    const lastCommentary = segments.commentary[segments.commentary.length - 1];
    segments.commentary.pop();
    const upgraded = { ...lastCommentary, kind: 'final', label: 'fallback final assistant' };
    segments.final.push(upgraded);
    const sequenceIndex = segments.sequence.findIndex(item => item.index === lastCommentary.index);
    if (sequenceIndex >= 0) segments.sequence[sequenceIndex] = upgraded;
  }

  const counts = {
    thinking: segments.thinking.length,
    tool: segments.tool.length,
    commentary: segments.commentary.length,
    final: segments.final.length,
    embeddedThinking: segments.embeddedThinking.length,
    embeddedTools: segments.embeddedTools.length,
    totalSegments: segments.sequence.length,
    rawMessages: messages.length,
  };
  const ratios = buildRatios(counts);
  const transitions = buildTransitions(segments.sequence);
  const labels = classifyConversation(source, counts);
  const patterns = buildPatterns(source, segments.sequence, transitions, counts);
  const sourceNotes = addSourceNotes(source, messages, counts, segments);
  const summary = buildSummary(source, counts, transitions, labels);

  return {
    conversationId: input.conversationId || '',
    source,
    summary,
    segments,
    metrics: {
      counts,
      ratios,
      messageStats: {
        rawMessages: messages.length,
        assistantMessages: messages.filter(message => message.role === 'assistant').length,
        userMessages: messages.filter(message => message.role === 'user').length,
      },
    },
    transitions,
    patterns,
    sourceNotes,
  };
}

module.exports = {
  analyzeConversationMechanism,
};
