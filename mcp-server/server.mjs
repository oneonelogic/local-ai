#!/usr/bin/env node
// Local Qwen MCP server.
// Exposes tools that let Claude Code delegate subtasks to the local Qwen
// model running on cyberpc (Ollama, RTX 4090) over the LAN. Local-only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { search as searchVault } from "./vault-search.mjs";
import { HOSTS, pickHost, probeStatus, invalidateProbeCache } from "./hosts.mjs";

// 30B on a 4090 can take a while for long outputs; generous ceiling.
const TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS || 600000);

const DEFAULT_SYSTEM =
  "You are a focused coding assistant working as a delegate. Complete the " +
  "delegated subtask precisely and completely. Return only the requested " +
  "result (code, text, or answer) with no preamble, no apologies, and no " +
  "meta-commentary unless explicitly asked. If given context, use it faithfully.";

async function ollama(host, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${host.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer({ name: "local-qwen", version: "1.0.0" });

server.registerTool(
  "delegate_to_local",
  {
    title: "Delegate a subtask to local Qwen",
    description:
      "Hand a well-scoped subtask to a local Qwen model (free, unmetered, runs " +
      "on a local RTX 4090). Routes to GCONZ-WIN-AI when it is powered on, and " +
      "falls back automatically to the always-on GCONZ-OPS otherwise. Good for " +
      "boilerplate, first-draft tests/docstrings, summarizing or explaining a " +
      "file, mechanical edits, and other parallelizable grunt work. NOT for " +
      "hard reasoning, subtle bugs, or multi-file architecture — keep those on " +
      "Claude. Always review what it returns. Pass file contents or data via " +
      "`context`.",
    inputSchema: {
      task: z
        .string()
        .describe("The instruction for the local model. Be specific and self-contained."),
      context: z
        .string()
        .optional()
        .describe("Supporting content the model needs: file contents, code, data, logs."),
      model: z
        .string()
        .optional()
        .describe(
          "Model tag to use. Omit to use whichever host answers and its own " +
            `default (${HOSTS.map((h) => `${h.name}: ${h.model}`).join(", ")}). ` +
            "Naming a model restricts routing to hosts that actually have it."
        ),
      temperature: z
        .number()
        .optional()
        .describe("Sampling temperature. Default 0.2 (low, for deterministic coding)."),
    },
  },
  async ({ task, context, model, temperature }) => {
    const prompt = context ? `${task}\n\n--- CONTEXT ---\n${context}` : task;
    const started = Date.now();
    const tried = [];
    let lastErr;

    // Two passes: if the chosen host dies mid-request (it can be powered off at
    // any moment), re-probe and try whatever else is up before giving up.
    for (let attempt = 0; attempt < HOSTS.length; attempt++) {
      let host;
      try {
        host = await pickHost(model, { exclude: tried });
      } catch (err) {
        lastErr = err;
        break;
      }
      tried.push(host.name);
      const useModel = model || host.model;
      try {
        const data = await ollama(host, "/api/chat", {
          model: useModel,
          messages: [
            { role: "system", content: DEFAULT_SYSTEM },
            { role: "user", content: prompt },
          ],
          stream: false,
          options: {
            num_ctx: host.numCtx,
            temperature: temperature ?? 0.2,
          },
        });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const out = data?.message?.content ?? "(empty response)";
        const evalCount = data?.eval_count ?? "?";
        const footer = `\n\n---\n[${host.name} · ${useModel} · ${evalCount} tokens · ${secs}s]`;
        return { content: [{ type: "text", text: out + footer }] };
      } catch (err) {
        lastErr = err;
        invalidateProbeCache(); // this host just proved unreliable; re-probe
      }
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Local delegation failed: ${lastErr?.message ?? "unknown error"}\n\n` +
            (tried.length ? `Tried: ${tried.join(", ")}.\n` : "") +
            `Hosts in pool: ${HOSTS.map((h) => `${h.name} @ ${h.url}`).join(", ")}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "local_ai_status",
  {
    title: "Local AI status",
    description:
      "Report which local Ollama hosts are reachable (cyberpc, then the " +
      "always-on GCONZ-OPS fallback), which models each has installed, and " +
      "which are currently loaded in GPU.",
    inputSchema: {},
  },
  async () => {
    invalidateProbeCache(); // an explicit status check should never read stale
    const status = await probeStatus();

    const blocks = await Promise.all(
      status.map(async ({ host, live }) => {
        if (!live) return `✗ ${host.name} (${host.url}) — unreachable`;

        const ps = await fetch(`${host.url}/api/ps`)
          .then((r) => (r.ok ? r.json() : { models: [] }))
          .catch(() => ({ models: [] }));

        const installed = live.models.length
          ? live.models.map((m) => `    - ${m}`).join("\n")
          : "    (none)";
        const loaded = (ps.models || []).length
          ? (ps.models || [])
              .map(
                (m) =>
                  `    - ${m.name} → ${
                    m.size_vram ? (m.size_vram / 1e9).toFixed(1) + " GB in VRAM" : "loaded"
                  }`
              )
              .join("\n")
          : "    (none currently loaded)";

        return (
          `✓ ${host.name} (${host.url}) — default model ${host.model}, num_ctx ${host.numCtx}\n` +
          `  installed:\n${installed}\n` +
          `  loaded in GPU now:\n${loaded}`
        );
      })
    );

    const up = status.filter((s) => s.live);
    const header = up.length
      ? `Delegation would route to: ${up[0].host.name}\n\n`
      : `No local host is reachable — delegation will fail.\n\n`;

    return {
      content: [{ type: "text", text: header + blocks.join("\n\n") }],
      ...(up.length ? {} : { isError: true }),
    };
  }
);

server.registerTool(
  "search_vault",
  {
    title: "Search the Obsidian vault",
    description:
      "Semantic + keyword search over gconz's personal Obsidian notes " +
      "(~/Docs). Returns the most relevant note " +
      "chunks with their file path and heading so you can read the source. " +
      "Use it to recall past decisions, project context, ideas, sermons, or " +
      "anything gconz has written down. Embeddings run locally on cyberpc; " +
      "if the index is missing, run index-vault.mjs to build it.",
    inputSchema: {
      query: z.string().describe("Natural-language search query."),
      k: z.number().optional().describe("Number of results to return (default 8)."),
      mode: z
        .enum(["hybrid", "vector", "keyword"])
        .optional()
        .describe("Search mode. Default 'hybrid' (vector + keyword)."),
    },
  },
  async ({ query, k, mode }) => {
    try {
      const results = await searchVault(query, k ?? 8, mode ?? "hybrid");
      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text: "No matches found (the vault index may be empty — run index-vault.mjs).",
            },
          ],
        };
      }
      const text = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.path}${r.heading ? " › " + r.heading : ""}  ` +
            `(cos ${r.cos}, kw ${r.keywordHits})\n${r.snippet}`
        )
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Vault search failed: ${err.message}\n\n` +
              `If the index is missing, run: node index-vault.mjs\n` +
              `Search needs a host with the "${process.env.EMBED_MODEL || "nomic-embed-text"}" ` +
              `embedding model: ${HOSTS.map((h) => `${h.name} @ ${h.url}`).join(", ")}.`,
          },
        ],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
