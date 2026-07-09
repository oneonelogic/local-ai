// Vault semantic search — pure-JS, in-memory vector store.
// Chunks the Obsidian vault, embeds each chunk via nomic-embed-text on cyberpc,
// stores a JSON index, and does hybrid (vector + keyword) search over it.
// The vault is small (~600 notes / ~5MB), so no SQLite/sqlite-vec is needed.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://192.168.1.232:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const VAULT_PATH =
  process.env.VAULT_PATH || "/Users/gconz/Documents/gconz_obsidian_vault";

const __dir = dirname(fileURLToPath(import.meta.url));
export const INDEX_PATH = process.env.VAULT_INDEX || join(__dir, "vault-index.json");

const MAX_CHUNK = 1400; // chars per chunk before windowing
const OVERLAP = 200; // char overlap between windows of a long section
const BATCH = 24; // embeddings per Ollama request
const EMBED_TIMEOUT_MS = 60000;

// --- Embeddings ---------------------------------------------------------

// nomic-embed-text wants asymmetric task prefixes: documents vs queries.
export async function embed(texts, kind = "document", onProgress) {
  const prefix = kind === "query" ? "search_query: " : "search_document: ";
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => prefix + t);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`embed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
      const data = await res.json();
      out.push(...data.embeddings);
    } finally {
      clearTimeout(timer);
    }
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

// --- Vault walking & chunking ------------------------------------------

async function walk(dir, acc) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // skip .obsidian, .trash, hidden
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (extname(e.name).toLowerCase() === ".md") acc.push(full);
  }
  return acc;
}

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) return text.slice(end + 4);
  }
  return text;
}

// Split a markdown file into chunks, one per heading-section, windowing long
// sections. Each chunk carries the nearest heading for context.
function chunkFile(relPath, raw) {
  const text = stripFrontmatter(raw);
  const sections = [];
  let heading = "";
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ heading, body });
    buf = [];
  };
  for (const line of text.split("\n")) {
    const m = /^(#{1,6})\s+(.*)/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const s of sections) {
    if (s.body.length <= MAX_CHUNK) {
      chunks.push({ path: relPath, heading: s.heading, text: s.body });
    } else {
      for (let i = 0; i < s.body.length; i += MAX_CHUNK - OVERLAP) {
        const piece = s.body.slice(i, i + MAX_CHUNK).trim();
        if (piece) chunks.push({ path: relPath, heading: s.heading, text: piece });
      }
    }
  }
  return chunks;
}

// Text fed to the embedder: note title + heading as context, then the body.
function docText(c) {
  const title = c.path.replace(/\.md$/i, "");
  const ctx = c.heading ? `${title} > ${c.heading}` : title;
  return `${ctx}\n${c.text}`;
}

// --- Index build & load -------------------------------------------------

export async function buildIndex({ onProgress } = {}) {
  const files = await walk(VAULT_PATH, []);
  const chunks = [];
  for (const f of files) {
    const raw = await readFile(f, "utf8").catch(() => "");
    const rel = relative(VAULT_PATH, f);
    for (const c of chunkFile(rel, raw)) chunks.push(c);
  }
  const vectors = await embed(chunks.map(docText), "document", onProgress);
  const index = {
    model: EMBED_MODEL,
    dim: vectors[0]?.length ?? 0,
    vaultPath: VAULT_PATH,
    createdMs: Date.now(),
    chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i] })),
  };
  const json = JSON.stringify(index);
  await writeFile(INDEX_PATH, json);
  return { files: files.length, chunks: chunks.length, bytes: json.length };
}

let CACHE = null;
export async function loadIndex() {
  if (CACHE) return CACHE;
  const idx = JSON.parse(await readFile(INDEX_PATH, "utf8"));
  for (const c of idx.chunks) {
    let n = 0;
    for (const x of c.vector) n += x * x;
    c._norm = Math.sqrt(n) || 1;
  }
  CACHE = idx;
  return CACHE;
}

// --- Search -------------------------------------------------------------

function snippet(text, terms, len = 300) {
  const lc = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lc.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  let s = text.slice(start, start + len).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (start + len < text.length) s += "…";
  return s;
}

export async function search(query, k = 8, mode = "hybrid") {
  const idx = await loadIndex();
  const [qv] = await embed([query], "query");
  let qn = 0;
  for (const x of qv) qn += x * x;
  qn = Math.sqrt(qn) || 1;
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];

  const scored = idx.chunks.map((c) => {
    const v = c.vector;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    const cos = dot / (c._norm * qn);
    let kw = 0;
    if (mode !== "vector") {
      const lc = c.text.toLowerCase();
      for (const t of terms) if (lc.includes(t)) kw++;
    }
    const score =
      mode === "vector" ? cos : mode === "keyword" ? kw : cos + 0.03 * kw;
    return { c, cos, kw, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ c, cos, kw }) => ({
    path: c.path,
    heading: c.heading,
    cos: +cos.toFixed(3),
    keywordHits: kw,
    snippet: snippet(c.text, terms),
  }));
}
