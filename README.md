# Chronicler

Chronicler is a local-first conversation viewer for AI coding tools. It reads your saved chats from Claude Code, OpenAI Codex CLI, and Cursor, then lets you browse them in one interface and generate reusable summaries.

Current version: `v0.1.1` (usable multi-source MVP, still evolving).

## What It Does

- Aggregates conversations from multiple AI coding tools
- Shows sessions in a single searchable web UI
- Separates conversation browsing from a dedicated analytics dashboard
- Opens full message history for each conversation
- Preserves tool calls, thinking, and metadata where available
- Preserves agent-step detail from Cursor, including thinking, tool descriptions, tool inputs, and tool outputs where available
- Surfaces token usage references for Claude and Codex sessions, with best-effort references for Cursor when available
- Visualizes conversation activity by hour and weekday/hour heatmap
- Lets you switch dashboard analytics between `Tokens` and `Conversations`
- Filters dashboard analytics by preset windows or custom date ranges
- Generates AI summaries focused on user intent, intent evolution, agent reasoning, strategy, execution path, and turning points
- Saves generated summaries locally in `summaries/`

## Dashboard

The analytics dashboard provides a higher-level view of how your conversations are happening over time:

- `活跃时间分布`: conversation activity by hour of day
- `活跃热力图`: weekday x hour heatmap
- Overview cards for active days, peak hour, and timestamp coverage
- Per-source filtering for `Claude Code`, `Codex`, and `Cursor`
- Dashboard-only time filtering with `7d`, `30d`, `90d`, `1y`, `All`, and custom start/end dates
- Metric switching between `Tokens` and `Conversations`

Activity is currently bucketed by each conversation's latest known timestamp. In `Tokens` mode the charts aggregate `tokenUsage.total` per conversation; in `Conversations` mode they fall back to one conversation per bucket.

## Summary Output

AI summaries are designed to preserve problem-solving context, not just compress the final answer. The current summary structure includes:

- `问题背景`
- `用户意图 (Intent)`
- `意图演化`
- `Agent 的思路与判断`
- `策略与执行路径`
- `关键决策与转折点`
- `解决方案与结果`
- `核心洞察`
- `标签`

This makes Chronicler useful not only as a history browser, but also as a lightweight reflection and knowledge-capture tool for AI-assisted work.

## Supported Sources

| Tool | Storage location | Format |
|------|------------------|--------|
| Claude Code | `~/.claude/projects/` | JSONL |
| OpenAI Codex CLI | `~/.codex/sessions/` | JSONL |
| Cursor | `~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb` | SQLite |

## Source Coverage Notes

- `Claude Code`
  Reads user and assistant messages, thinking blocks, tool calls, tool results, and provider token usage metadata.
- `Codex CLI`
  Reads user messages, commentary/final answers, reasoning blocks, function calls, function call outputs, and token-count events.
- `Cursor`
  Reads conversations from the local SQLite database and reconstructs assistant steps, including thinking and tool traces where the underlying bubble data exposes them.

## Requirements

- Node.js 18+
- A local machine that already has one or more supported tools installed

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` if you want AI-generated summaries:

```bash
ANTHROPIC_API_KEY=your-key-here
PORT=3738
```

You can also use `OPENAI_API_KEY` instead of `ANTHROPIC_API_KEY`.

If no OpenAI key is found in `.env`, Chronicler can also fall back to a key discovered from Claude Desktop config on Windows.

## Running

Start the app:

```bash
npm start
```

Then open [http://localhost:3738](http://localhost:3738).

For development with auto-reload:

```bash
npm run dev
```

On Windows you can also double-click `start.bat`.

## Stats Fallback Behavior

If the browser is talking to an older running server process that still returns legacy `/api/stats` totals only, the frontend now falls back to computing activity stats from `/api/conversations` so the dashboard remains usable before you restart the app. The fallback also supports the newer time-range and `Tokens / Conversations` dashboard modes.

## Current Capabilities

- Browse conversations across Claude, Codex, and Cursor in one UI
- Search by title or project
- Switch between a reading-focused conversation view and a separate dashboard view
- Inspect conversation details, timestamps, thinking blocks, tool usage, and saved summaries
- Review conversation activity patterns across the day and week
- Slice dashboard analytics by time window without changing the conversation list
- Compare token-weighted and conversation-count activity patterns
- Re-run summaries and persist them to disk
- Review token usage references per conversation where the source exposes them

## Current Limitations

- Cursor token numbers are best-effort references only; many sessions expose no usable values
- Token totals shown for Claude include cached input references, which can make the numbers look large
- Summaries favor process fidelity over brevity, so long sessions can produce dense summary output
- This is still an MVP, so data extraction quality depends on what each source actually records locally

## Privacy

Chronicler reads conversation data directly from local storage on your machine.

- Conversation history stays local
- Nothing is uploaded by default
- Only the optional summary request is sent to your configured AI provider

## Project Structure

```text
Chronicler/
├── public/          # Frontend UI
├── readers/         # Source-specific conversation readers
├── summaries/       # Saved summary markdown files
├── .env.example
├── .gitignore
├── package.json
├── server.js
└── start.bat
```

## GitHub Notes

This repository is prepared for GitHub upload:

- `node_modules/` is ignored
- real `.env` files are ignored
- generated `summaries/` content is ignored

## License

MIT
