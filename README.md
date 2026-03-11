# Chronicler

Chronicler is a local-first conversation viewer for AI coding tools. It reads your saved chats from Claude Code, OpenAI Codex CLI, and Cursor, then lets you browse them in one interface and generate reusable summaries.

## What It Does

- Aggregates conversations from multiple AI coding tools
- Shows sessions in a single searchable web UI
- Opens full message history for each conversation
- Preserves tool calls, thinking, and metadata where available
- Generates AI summaries and saves them locally in `summaries/`

## Supported Sources

| Tool | Storage location | Format |
|------|------------------|--------|
| Claude Code | `~/.claude/projects/` | JSONL |
| OpenAI Codex CLI | `~/.codex/sessions/` | JSONL |
| Cursor | `~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb` | SQLite |

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
