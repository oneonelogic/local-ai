#!/usr/bin/env node
// Terminal wrapper for vault search.
//   node search.mjs "your query"
//   node search.mjs -k 5 --mode vector "your query"
//   node search.mjs --full "your query"      # print full chunk text, not a snippet
import { search } from "./vault-search.mjs";

const args = process.argv.slice(2);
let k = 8;
let mode = "hybrid";
let full = false;
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-k" || a === "--k") k = Number(args[++i]);
  else if (a === "--mode" || a === "-m") mode = args[++i];
  else if (a === "--full" || a === "-f") full = true;
  else if (a === "-h" || a === "--help") {
    console.log(
      "Usage: node search.mjs [-k N] [--mode hybrid|vector|keyword] [--full] \"query\""
    );
    process.exit(0);
  } else words.push(a);
}

const query = words.join(" ").trim();
if (!query) {
  console.error('Error: no query given.\nUsage: node search.mjs "your query"');
  process.exit(1);
}
if (!["hybrid", "vector", "keyword"].includes(mode)) {
  console.error(`Error: --mode must be hybrid, vector, or keyword (got "${mode}").`);
  process.exit(1);
}

try {
  const results = await search(query, k, mode);
  if (!results.length) {
    console.log("No matches. If this is unexpected, rebuild: node index-vault.mjs");
    process.exit(0);
  }
  console.log(`\n${results.length} result(s) for "${query}" (${mode}):\n`);
  for (const [i, r] of results.entries()) {
    const loc = r.path + (r.heading ? " › " + r.heading : "");
    console.log(`${i + 1}. ${loc}`);
    console.log(`   [cos ${r.cos}, kw ${r.keywordHits}]`);
    console.log(`   ${full ? r.snippet : r.snippet.slice(0, 220)}\n`);
  }
} catch (err) {
  console.error(`Search failed: ${err.message}`);
  console.error("If the index is missing, run: node index-vault.mjs");
  console.error("Embeddings need cyberpc up (Ollama at 192.168.1.232:11434).");
  process.exit(1);
}
