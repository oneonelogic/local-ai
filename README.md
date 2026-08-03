# local-ai

Personal local-AI setup: local Qwen models on LAN RTX 4090 boxes, wired into
Claude Code and VS Code, plus semantic search over a personal Obsidian vault.
Everything runs on the LAN — no cloud inference.

## Host pool and failover

Two hosts serve Ollama, tried in this order (`mcp-server/hosts.mjs`):

| Host | GPU | Default model | num_ctx | Notes |
|---|---|---|---|---|
| **GCONZ-WIN-AI** (`ssh cyberpc`, `192.168.1.232`) | Desktop 4090, 24 GB | `qwen3-coder:30b` | 32768 | Faster and stronger, but often powered off (noise/heat) |
| **GCONZ-OPS** (`ssh ops`, `192.168.1.153`) | Laptop 4090, 16 GB | `qwen2.5-coder:14b` | 16384 | Always on; the fallback |

Hosts are probed (2.5 s timeout, cached 30 s) and the first reachable one wins.
If a host dies mid-request the call re-probes and retries elsewhere, so a box
being powered off mid-task is not fatal. Naming a `model` restricts routing to
hosts that actually have it; embeddings always route to a host carrying
`nomic-embed-text`, since query vectors must match the model the index was built
with (verified bit-identical across both hosts).

The two boxes differ enough that each declares its own defaults. GCONZ-OPS has
16 GB, not 24 — the Laptop 4090 is AD103 — so `qwen3-coder:30b` (18 GB) does not
fit there, and 32k context on the 14B would overflow VRAM (~0.19 MB/token of KV
cache). Setting `OLLAMA_URL` collapses the pool to that single host.

Measured 2026-08-03 on an identical commit-review task, both warm:
GCONZ-WIN-AI **206 tok/s**, GCONZ-OPS **54 tok/s**, with noticeably more
specific output from the 30B. Treat GCONZ-OPS as a capable stand-in, not a peer.
Caveat: a cold start on GCONZ-WIN-AI costs ~2 min to load 18 GB, so the first
call after power-on is slow regardless.

## The stack

- **Claude** — primary assistant (Claude Code).
- **Local Qwen minion** — exposed to Claude Code as the `delegate_to_local` MCP
  tool for cheap, parallelizable grunt work; routed per the pool above.
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
| `hosts.mjs` | Host pool, probing and failover |
| `vault-search.mjs` | Chunk / embed / hybrid-search the Obsidian vault |
| `index-vault.mjs` | Build the vault index |
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

`OLLAMA_URL` (pins to one host, disabling failover), `LOCAL_MODEL` and
`LOCAL_NUM_CTX` (only used alongside `OLLAMA_URL`), `LOCAL_TIMEOUT_MS`,
`EMBED_MODEL` (`nomic-embed-text`), `VAULT_PATH`, `VAULT_INDEX`.

## Privacy

`vault-index.json` contains the **full text** of every indexed note and is
git-ignored. It never leaves this machine. Rebuild it locally with
`node index-vault.mjs`.
