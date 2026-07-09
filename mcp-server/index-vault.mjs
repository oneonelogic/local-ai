#!/usr/bin/env node
// Rebuilds the vault search index. Run manually after editing notes, or on a
// schedule. Embeddings run on cyberpc, so that box must be reachable.
import { buildIndex, INDEX_PATH } from "./vault-search.mjs";

const t0 = Date.now();
console.log("Indexing vault (embeddings run on cyberpc)…");
try {
  const stats = await buildIndex({
    onProgress: (done, total) =>
      process.stdout.write(`\r  embedded ${done}/${total} chunks`),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDone: ${stats.chunks} chunks from ${stats.files} notes in ${secs}s`
  );
  console.log(`Index: ${INDEX_PATH} (${(stats.bytes / 1e6).toFixed(1)} MB)`);
} catch (err) {
  console.error(`\nIndexing failed: ${err.message}`);
  console.error("Is cyberpc up and serving Ollama at 192.168.1.232:11434?");
  process.exit(1);
}
