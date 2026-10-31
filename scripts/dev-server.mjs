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
// SLOW_MS=300 имитирует задержку хранилища, как на Netlify
const SLOW_MS = Number(process.env.SLOW_MS) || 0;
const pause = () => (SLOW_MS ? new Promise(r => setTimeout(r, SLOW_MS)) : null);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

const memory = new Map();
const store = {
  async get(key, opts) {
    await pause();
    const v = memory.get(key);
    if (v == null) return null;
    return opts?.type === "json" ? JSON.parse(v) : v;
  },
  async set(key, value) { await pause(); memory.set(key, value); },
  async setJSON(key, value) { await pause(); memory.set(key, JSON.stringify(value)); },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/room") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const r = await handle(new Request(url, {
        method: req.method,
        headers: { "x-room-code": String(req.headers["x-room-code"] ?? "") },
        body: req.method === "POST" ? body : undefined,
      }), store);
      res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
      return res.end(await r.text());
    }
    // статика: страница, манифест, service worker и иконки
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(root, file);
    const type = TYPES[path.extname(file)];
    if (type && full.startsWith(root) && !file.startsWith("netlify") && fs.existsSync(full)) {
      res.writeHead(200, { "content-type": type });
      return res.end(fs.readFileSync(full));
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
