// Ollama host pool with failover.
//
// cyberpc is the capable box but is powered off much of the time (noise/heat),
// so GCONZ-OPS acts as an always-on fallback. The two carry different models
// and have different VRAM budgets, so each host declares its own defaults
// rather than sharing one global setting.
//
// Setting OLLAMA_URL collapses the pool to that single host, preserving the
// previous single-box behaviour for anyone who relies on it.

const ENV_URL = process.env.OLLAMA_URL;

export const HOSTS = ENV_URL
  ? [
      {
        name: "configured",
        url: ENV_URL,
        model: process.env.LOCAL_MODEL || "qwen3-coder:30b",
        numCtx: Number(process.env.LOCAL_NUM_CTX || 32768),
      },
    ]
  : [
      {
        // Fleet name; the SSH alias and older notes still call this "cyberpc".
        name: "GCONZ-WIN-AI",
        url: "http://192.168.1.232:11434",
        model: "qwen3-coder:30b",
        // Desktop 4090, 24 GB.
        numCtx: 32768,
      },
      {
        name: "GCONZ-OPS",
        // Wired IP — OPS's Wi-Fi (.153) was retired 2026-08-07.
        url: "http://192.168.1.212:11434",
        model: "qwen2.5-coder:14b",
        // Laptop 4090 is AD103 with only 16 GB. The 14B weights take ~9 GB and
        // this model's KV cache runs ~0.19 MB/token, so 32k context would need
        // ~6 GB on top and overflow to CPU. 16k keeps it comfortably resident.
        numCtx: 16384,
      },
    ];

const PROBE_TIMEOUT_MS = 2500;
const PROBE_CACHE_MS = 30_000;

let probeCache = null; // { at, results }

async function probe(host) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${host.url}/api/tags`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return { ...host, models: (data.models || []).map((m) => m.name) };
  } catch {
    return null; // unreachable hosts are expected, not exceptional
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll() {
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.results;
  const results = await Promise.all(HOSTS.map(probe));
  probeCache = { at: Date.now(), results };
  return results;
}

// Ollama tags carry an explicit version ("nomic-embed-text:latest"), so a bare
// name has to match the family rather than the exact string.
export function hasModel(models, want) {
  if (!want) return true;
  if (models.includes(want)) return true;
  return want.includes(":") ? false : models.some((m) => m.startsWith(want + ":"));
}

/**
 * First reachable host, preferring pool order. If `needModel` is given, the
 * host must actually have that model — no point routing an embedding request
 * to a box without the embedder.
 */
export async function pickHost(needModel, { exclude = [] } = {}) {
  const results = await probeAll();
  const up = results.filter(Boolean).filter((h) => !exclude.includes(h.name));

  if (!up.length) {
    const scope = exclude.length ? ` other than ${exclude.join(", ")}` : "";
    throw new Error(
      `no Ollama host reachable${scope} ` +
        `(tried ${HOSTS.map((h) => `${h.name} @ ${h.url}`).join(", ")})`
    );
  }
  if (!needModel) return up[0];

  const match = up.find((h) => hasModel(h.models, needModel));
  if (match) return match;

  throw new Error(
    `model "${needModel}" is not installed on any reachable host ` +
      `(${up.map((h) => h.name).join(", ")}). Pull it there, or pick another model.`
  );
}

/** Every host with its probe result (null when unreachable), in pool order. */
export async function probeStatus() {
  const results = await probeAll();
  return HOSTS.map((host, i) => ({ host, live: results[i] }));
}

export function invalidateProbeCache() {
  probeCache = null;
}
