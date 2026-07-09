// Minimal MCP stdio test client: spawn the server, handshake, call a tool.
import { spawn } from "node:child_process";

const server = spawn("node", ["server.mjs"], { cwd: import.meta.dirname });
let buf = "";
const pending = new Map();
let idc = 0;

server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
server.stderr.on("data", (d) => process.stderr.write("[server] " + d));

function rpc(method, params) {
  const id = ++idc;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0" },
});
console.log("initialize ok:", init.result?.serverInfo);
notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name));

console.log("\n--- calling delegate_to_local ---");
const call = await rpc("tools/call", {
  name: "delegate_to_local",
  arguments: { task: "Write a Python one-liner that returns the reversed of a string s. Just the code." },
});
console.log(call.result.content[0].text);

server.kill();
process.exit(0);
