import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || "0.0.0.0";
const HEARTBEAT_MS = 45000;
const MAX_MISSED_PONGS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** @type {Map<string, Map<string, import("ws").WebSocket>>} */
const rooms = new Map();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  const members = rooms.get(room);
  ws.room = null;
  if (!members) return;
  members.delete(ws.id);
  for (const peer of members.values()) {
    send(peer, { type: "peer-left", id: ws.id });
  }
  if (members.size === 0) rooms.delete(room);
}

function adoptResumeId(ws, resumeId) {
  if (typeof resumeId !== "string" || !UUID_RE.test(resumeId)) return;
  for (const members of rooms.values()) {
    const old = members.get(resumeId);
    if (old && old !== ws) {
      members.delete(resumeId);
      old.room = null;
      if (old.leaveTimer) {
        clearTimeout(old.leaveTimer);
        old.leaveTimer = null;
      }
      old.id = randomUUID();
      try {
        old.terminate();
      } catch {
        /* ignore */
      }
    }
  }
  ws.id = resumeId;
}

function joinRoom(ws, rawRoom, resumeId) {
  adoptResumeId(ws, resumeId);
  const room = String(rawRoom || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 32);
  if (!room) {
    send(ws, { type: "error", message: "Enter a room code to join." });
    return;
  }
  leaveRoom(ws);
  if (!rooms.has(room)) rooms.set(room, new Map());
  const members = rooms.get(room);
  const peers = [...members.keys()];
  members.set(ws.id, ws);
  ws.room = room;
  send(ws, { type: "joined", room, peers });
  for (const [id, peer] of members) {
    if (id !== ws.id) send(peer, { type: "peer-joined", id: ws.id });
  }
}

function relay(ws, message) {
  if (!ws.room || typeof message.to !== "string") return;
  const members = rooms.get(ws.room);
  const target = members?.get(message.to);
  if (!target) return;
  send(target, { ...message, from: ws.id });
}

const LEAVE_GRACE_MS = 15000;

function cancelLeaveTimer(ws) {
  if (ws.leaveTimer) {
    clearTimeout(ws.leaveTimer);
    ws.leaveTimer = null;
  }
}

function scheduleLeave(ws) {
  cancelLeaveTimer(ws);
  const id = ws.id;
  const room = ws.room;
  ws.leaveTimer = setTimeout(() => {
    ws.leaveTimer = null;
    // Only leave if this socket still owns the seat (no resume replaced it).
    if (ws.room !== room) return;
    if (room && rooms.get(room)?.get(id) === ws) leaveRoom(ws);
  }, LEAVE_GRACE_MS);
}

wss.on("connection", (ws) => {
  ws.id = randomUUID();
  ws.room = null;
  ws.isAlive = true;
  ws.missedPongs = 0;
  ws.leaveTimer = null;
  send(ws, { type: "welcome", id: ws.id });

  ws.on("pong", () => {
    ws.isAlive = true;
    ws.missedPongs = 0;
  });

  ws.on("message", (raw) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (message.type) {
      case "join":
        cancelLeaveTimer(ws);
        joinRoom(ws, message.room, message.resumeId);
        break;
      case "leave":
        cancelLeaveTimer(ws);
        leaveRoom(ws);
        break;
      case "offer":
      case "answer":
      case "ice":
        relay(ws, message);
        break;
      case "ping":
        send(ws, { type: "pong" });
        break;
      default:
        break;
    }
  });

  ws.on("close", () => scheduleLeave(ws));
});

// Cloudflare quick tunnels can delay WS control frames; be patient.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!ws.isAlive) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      if (ws.missedPongs >= MAX_MISSED_PONGS) {
        ws.terminate();
        continue;
      }
    } else {
      ws.missedPongs = 0;
    }
    // Any app-level ping/join also clears isAlive via message handler.
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Talkback voice rooms → http://127.0.0.1:${PORT}`);
});
