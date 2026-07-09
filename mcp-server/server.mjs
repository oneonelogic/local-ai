#!/usr/bin/env node
// Local Qwen MCP server.
// Exposes tools that let Claude Code delegate subtasks to the local Qwen
// model running on cyberpc (Ollama, RTX 4090) over the LAN. Local-only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { search as searchVault } from "./vault-search.mjs";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://192.168.1.232:11434";
const DEFAULT_MODEL = process.env.LOCAL_MODEL || "qwen3-coder:30b";
const NUM_CTX = Number(process.env.LOCAL_NUM_CTX || 32768);
// 30B on a 4090 can take a while for long outputs; generous ceiling.
const TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS || 600000);

const DEFAULT_SYSTEM =
  "You are a focused coding assistant working as a delegate. Complete the " +
  "delegated subtask precisely and completely. Return only the requested " +
  "result (code, text, or answer) with no preamble, no apologies, and no " +
  "meta-commentary unless explicitly asked. If given context, use it faithfully.";

async function ollama(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}${path}`, {
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

async function ollamaGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${OLLAMA_URL}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
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
      "Hand a well-scoped subtask to the local Qwen model on cyberpc (free, " +
      "unmetered, runs on the RTX 4090). Good for boilerplate, first-draft " +
      "tests/docstrings, summarizing or explaining a file, mechanical edits, " +
      "and other parallelizable grunt work. NOT for hard reasoning, subtle " +
      "bugs, or multi-file architecture — keep those on Claude. Always review " +
      "what it returns. Pass file contents or data via `context`.",
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
        .describe(`Model tag to use. Default: ${DEFAULT_MODEL}.`),
      temperature: z
        .number()
        .optional()
        .describe("Sampling temperature. Default 0.2 (low, for deterministic coding)."),
    },
  },
  async ({ task, context, model, temperature }) => {
    const prompt = context ? `${task}\n\n--- CONTEXT ---\n${context}` : task;
    const started = Date.now();
    try {
      const data = await ollama("/api/chat", {
        model: model || DEFAULT_MODEL,
        messages: [
          { role: "system", content: DEFAULT_SYSTEM },
          { role: "user", content: prompt },
        ],
        stream: false,
        options: {
          num_ctx: NUM_CTX,
          temperature: temperature ?? 0.2,
        },
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const out = data?.message?.content ?? "(empty response)";
      const evalCount = data?.eval_count ?? "?";
      const footer = `\n\n---\n[local ${model || DEFAULT_MODEL} · ${evalCount} tokens · ${secs}s]`;
      return { content: [{ type: "text", text: out + footer }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Local delegation failed: ${err.message}\n\n` +
              `Check that cyberpc (${OLLAMA_URL}) is up and Ollama is running.`,
          },
        ],
      };
    }
  }
);

server.registerTool(
  "local_ai_status",
  {
    title: "Local AI status",
    description:
      "Report whether the local Ollama box (cyberpc) is reachable, which " +
      "models are installed, and which are currently loaded in the GPU.",
    inputSchema: {},
  },
  async () => {
    try {
      const [tags, ps] = await Promise.all([
        ollamaGet("/api/tags"),
        ollamaGet("/api/ps").catch(() => ({ models: [] })),
      ]);
      const installed = (tags.models || [])
        .map((m) => `  - ${m.name} (${(m.size / 1e9).toFixed(1)} GB)`)
        .join("\n");
      const loaded = (ps.models || []).length
        ? (ps.models || [])
            .map((m) => `  - ${m.name} → ${m.size_vram ? (m.size_vram / 1e9).toFixed(1) + " GB in VRAM" : "loaded"}`)
            .join("\n")
        : "  (none currently loaded)";
      return {
        content: [
          {
            type: "text",
            text:
              `cyberpc Ollama reachable at ${OLLAMA_URL}\n\n` +
              `Installed models:\n${installed}\n\n` +
              `Loaded in GPU now:\n${loaded}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `cyberpc unreachable at ${OLLAMA_URL}: ${err.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  "search_vault",
  {
    title: "Search the Obsidian vault",
    description:
      "Semantic + keyword search over gconz's personal Obsidian notes " +
      "(~/Documents/gconz_obsidian_vault). Returns the most relevant note " +
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
              `Embeddings require cyberpc (${OLLAMA_URL}) to be up.`,
          },
        ],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
