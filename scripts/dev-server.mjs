// Локальный запуск игры без Netlify: `npm run dev`.
// Ответы и свои вопросы хранятся в памяти и пропадают после перезапуска.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../netlify/functions/room.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8888;

const memory = new Map();
const store = {
  async get(key, opts) {
    const v = memory.get(key);
    if (v == null) return null;
    return opts?.type === "json" ? JSON.parse(v) : v;
  },
  async set(key, value) { memory.set(key, value); },
  async setJSON(key, value) { memory.set(key, JSON.stringify(value)); },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/room") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const r = await handle(new Request(url, { method: req.method, body: req.method === "POST" ? body : undefined }), store);
      res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
      return res.end(await r.text());
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(root, "index.html")));
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Server error");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`\n💗 Игра запущена: http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.internal) console.log(`📱 С телефона в той же Wi-Fi: http://${n.address}:${PORT}`);
    }
  }
  console.log("Остановить: Ctrl+C\n");
});
