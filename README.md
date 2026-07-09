# local-ai

Personal local-AI setup: a local Qwen model on an RTX 4090 box (**cyberpc**,
Ollama) wired into Claude Code and VS Code, plus semantic search over a personal
Obsidian vault. Everything runs on the LAN — no cloud inference.

## The stack

- **Claude** — primary assistant (Claude Code).
- **Local Qwen minion** — `qwen3-coder:30b` on cyberpc, exposed to Claude Code
  as the `delegate_to_local` MCP tool for cheap, parallelizable grunt work.
- **Vault search** — `search_vault` MCP tool: semantic + keyword search over the
  Obsidian vault, embedded locally with `nomic-embed-text`.
- **Continue.dev** — local Qwen in VS Code (chat + autocomplete), configured in
  `~/.continue/config.yaml`.

## `mcp-server/`

A stdio MCP server (Node, `@modelcontextprotocol/sdk`) that talks to cyberpc's
Ollama over the LAN. Registered at user scope, so its tools are available in
every Claude Code project.

| File | Purpose |
|---|---|
| `server.mjs` | MCP server: `delegate_to_local`, `local_ai_status`, `search_vault` |
| `vault-search.mjs` | Chunk / embed / hybrid-search the Obsidian vault |
| `index-vault.mjs` | Build the vault index (embeds notes on cyberpc) |
| `search.mjs` | Terminal search CLI |

### Setup

```bash
cd mcp-server
npm install

# Build the vault index (needs cyberpc up). Rebuild after editing notes.
node index-vault.mjs

# Register the MCP server (user scope — available in every project)
claude mcp add --scope user local-qwen -- node "$PWD/server.mjs"
```

### Terminal search

```bash
node mcp-server/search.mjs "on-prem vs cloud decision"
node mcp-server/search.mjs -k 5 --mode vector "running AI locally"
node mcp-server/search.mjs --help
```

## Config (via environment)

`OLLAMA_URL` (default `http://192.168.1.232:11434`), `LOCAL_MODEL`
(`qwen3-coder:30b`), `EMBED_MODEL` (`nomic-embed-text`), `VAULT_PATH`,
`VAULT_INDEX`.

## Privacy

`vault-index.json` contains the **full text** of every indexed note and is
git-ignored. It never leaves this machine. Rebuild it locally with
`node index-vault.mjs`.
