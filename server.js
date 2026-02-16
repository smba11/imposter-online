// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * Data model (in-memory MVP)
 * rooms[code] = {
 *   hostKey: string,
 *   phase: "lobby"|"role"|"discuss"|"vote"|"results",
 *   round: number,
 *   word: string|null,
 *   imposters: Set(playerKey),
 *   eliminated: Set(playerKey),
 *   votes: Map(voterKey -> targetKey),
 *   timer: { endsAt: number, durationMs: number } | null,
 *   timerInterval: NodeJS.Timeout | null,
 *   players: Map(playerKey -> { key, name, socketId|null, connected:boolean })
 * }
 */

const rooms = Object.create(null);

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WORDS = [
  "Pizza", "Basketball", "School", "Netflix", "Soccer",
  "Seattle", "Airplane", "Coffee", "Concert", "Robots"
];

// Multi-imposter rule that matches your examples:
// 3->1, 5->2, 7->3, 9->4 ... always less imposters than total players
function imposterCount(n) {
  return Math.max(1, Math.floor((n - 1) / 2));
}

function roomPublicState(roomCode) {
  const r = rooms[roomCode];
  if (!r) return null;

  const playersArr = [...r.players.values()].map(p => ({
    key: p.key,
    name: p.name,
    connected: p.connected,
    eliminated: r.eliminated.has(p.key),
    // never reveal imposter here
  }));

  const now = Date.now();
  const remainingMs = r.timer ? Math.max(0, r.timer.endsAt - now) : null;

  return {
    roomCode,
    phase: r.phase,
    round: r.round,
    hostKey: r.hostKey,
    players: playersArr,
    timer: r.timer ? { remainingMs, durationMs: r.timer.durationMs } : null
  };
}

function emitRoom(roomCode) {
  const state = roomPublicState(roomCode);
  if (!state) return;
  io.to(roomCode).emit("room:update", state);
}

function safeClearTimer(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  if (r.timerInterval) clearInterval(r.timerInterval);
  r.timerInterval = null;
  r.timer = null;
}

function startPhaseTimer(roomCode, durationMs, onEnd) {
  const r = rooms[roomCode];
  if (!r) return;

  safeClearTimer(roomCode);

  r.timer = { endsAt: Date.now() + durationMs, durationMs };

  // lightweight tick: just update room state; clients can animate locally too
  r.timerInterval = setInterval(() => {
    const now = Date.now();
    if (!r.timer) return;

    if (now >= r.timer.endsAt) {
      safeClearTimer(roomCode);
      emitRoom(roomCode);
      onEnd?.();
    } else {
      emitRoom(roomCode);
    }
  }, 1000);

  emitRoom(roomCode);
}

function livingPlayers(room) {
  return [...room.players.values()].filter(p => !room.eliminated.has(p.key));
}

function livingCrewCount(room) {
  const living = livingPlayers(room);
  let crew = 0;
  for (const p of living) if (!room.imposters.has(p.key)) crew++;
  return crew;
}

function livingImposterCount(room) {
  const living = livingPlayers(room);
  let imp = 0;
  for (const p of living) if (room.imposters.has(p.key)) imp++;
  return imp;
}

function checkWin(room) {
  const imp = livingImposterCount(room);
  const crew = livingCrewCount(room);
  if (imp <= 0) return { over: true, winner: "CREW" };
  if (imp >= crew) return { over: true, winner: "IMPOSTERS" };
  return { over: false, winner: null };
}

function ensureRoom(roomCode) {
  return rooms[roomCode] || null;
}

function isHost(room, playerKey) {
  return room.hostKey === playerKey;
}

function nextRound(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  r.round += 1;
  r.phase = "role";
  r.votes = new Map();

  // Role reveal timer (short)
  startPhaseTimer(roomCode, 12_000, () => {
    // Discuss timer
    r.phase = "discuss";
    startPhaseTimer(roomCode, 60_000, () => {
      // Vote timer
      r.phase = "vote";
      startPhaseTimer(roomCode, 30_000, () => {
        // Auto-finish voting if time runs out
        finishVoting(roomCode);
      });
    });
  });

  // Send private role to each connected player
  const word = r.word;
  for (const p of r.players.values()) {
    if (!p.socketId) continue;
    if (r.eliminated.has(p.key)) continue;

    const isImp = r.imposters.has(p.key);
    io.to(p.socketId).emit("game:role", {
      role: isImp ? "IMPOSTER" : "CREW",
      word: isImp ? null : word,
      round: r.round
    });
  }

  emitRoom(roomCode);
}

function startGame(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  const living = livingPlayers(r);
  const n = living.length;

  r.phase = "role";
  r.round = 0;
  r.eliminated = new Set();
  r.votes = new Map();

  r.word = pickRandom(WORDS);
  r.imposters = new Set();

  const impN = imposterCount(n);
  const shuffled = living.map(p => p.key).sort(() => Math.random() - 0.5);
  for (let i = 0; i < impN; i++) r.imposters.add(shuffled[i]);

  nextRound(roomCode);
}

function finishVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  if (r.phase !== "vote") return;

  safeClearTimer(roomCode);

  // tally votes among living players
  const tally = new Map(); // targetKey -> count
  for (const [voterKey, targetKey] of r.votes.entries()) {
    if (r.eliminated.has(voterKey)) continue;
    if (!r.players.has(targetKey)) continue;
    if (r.eliminated.has(targetKey)) continue;
    tally.set(targetKey, (tally.get(targetKey) || 0) + 1);
  }

  // find max
  let max = 0;
  for (const c of tally.values()) max = Math.max(max, c);

  const top = [...tally.entries()].filter(([, c]) => c === max).map(([k]) => k);

  let eliminatedKey = null;
  if (top.length === 1 && max > 0) {
    eliminatedKey = top[0];
    r.eliminated.add(eliminatedKey);
  }

  r.phase = "results";

  // results payload (safe: still don’t reveal imposters list; only reveal eliminated role)
  const eliminatedInfo =
    eliminatedKey && r.players.has(eliminatedKey)
      ? {
          key: eliminatedKey,
          name: r.players.get(eliminatedKey).name,
          wasImposter: r.imposters.has(eliminatedKey)
        }
      : null;

  const win = checkWin(r);

  io.to(roomCode).emit("game:results", {
    eliminated: eliminatedInfo,
    win: win.over ? { winner: win.winner } : null
  });

  emitRoom(roomCode);

  // After a short results phase, either end game or go next round
  startPhaseTimer(roomCode, 10_000, () => {
    if (win.over) {
      // Back to lobby but keep room open
      safeClearTimer(roomCode);
      r.phase = "lobby";
      r.word = null;
      r.imposters = new Set();
      r.eliminated = new Set();
      r.votes = new Map();
      r.round = 0;
      emitRoom(roomCode);
    } else {
      nextRound(roomCode);
    }
  });
}

io.on("connection", (socket) => {
  // Rejoin-ready identity: client will send playerKey (stored in localStorage)
  // If playerKey exists in room, reattach.
  socket.on("room:joinOrCreate", ({ roomCode, name, playerKey, create }, cb) => {
    const cleanName = String(name || "").trim().slice(0, 20);
    const key = String(playerKey || "").trim();

    if (!cleanName) return cb?.({ ok: false, error: "Name required." });
    if (!key) return cb?.({ ok: false, error: "playerKey required." });

    if (create) {
      let code = makeRoomCode();
      while (rooms[code]) code = makeRoomCode();

      rooms[code] = {
        hostKey: key,
        phase: "lobby",
        round: 0,
        word: null,
        imposters: new Set(),
        eliminated: new Set(),
        votes: new Map(),
        timer: null,
        timerInterval: null,
        players: new Map()
      };

      const r = rooms[code];
      r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });

      socket.join(code);
      emitRoom(code);
      return cb?.({ ok: true, roomCode: code });
    }

    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });

    // If player exists: reattach
    if (r.players.has(key)) {
      const p = r.players.get(key);
      p.name = cleanName; // allow name update
      p.socketId = socket.id;
      p.connected = true;

      socket.join(code);
      emitRoom(code);
      return cb?.({ ok: true, roomCode: code, rejoined: true });
    }

    // New player join only allowed in lobby
    if (r.phase !== "lobby") return cb?.({ ok: false, error: "Game already started." });

    r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });
    socket.join(code);
    emitRoom(code);
    cb?.({ ok: true, roomCode: code });
  });

  socket.on("game:start", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can start." });

    const living = livingPlayers(r);
    if (living.length < 3) return cb?.({ ok: false, error: "Need at least 3 players." });

    startGame(code);
    cb?.({ ok: true });
  });

  socket.on("vote:cast", ({ roomCode, playerKey, targetKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (r.phase !== "vote") return cb?.({ ok: false, error: "Not voting phase." });

    if (!r.players.has(playerKey)) return cb?.({ ok: false, error: "Unknown player." });
    if (r.eliminated.has(playerKey)) return cb?.({ ok: false, error: "You are eliminated." });

    if (!r.players.has(targetKey)) return cb?.({ ok: false, error: "Invalid target." });
    if (r.eliminated.has(targetKey)) return cb?.({ ok: false, error: "Target eliminated." });

    // prevent self vote? (optional) — allowing is fine, but usually no:
    if (playerKey === targetKey) return cb?.({ ok: false, error: "Can't vote yourself." });

    r.votes.set(playerKey, targetKey);

    // UX: send vote status (count only) to everyone
    const living = livingPlayers(r);
    const votedCount = [...r.votes.keys()].filter(k => !r.eliminated.has(k)).length;
    io.to(code).emit("vote:status", { votedCount, total: living.length });

    // If everyone voted, finish early
    if (votedCount >= living.length) {
      finishVoting(code);
    } else {
      emitRoom(code);
    }

    cb?.({ ok: true });
  });

  socket.on("room:leave", ({ roomCode, playerKey }) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return;

    // keep player in room for rejoin UX, but mark offline
    if (r.players.has(playerKey)) {
      const p = r.players.get(playerKey);
      p.connected = false;
      p.socketId = null;

      // If host left, promote first connected or first living
      if (r.hostKey === playerKey) {
        const candidates = [...r.players.values()].filter(pp => pp.connected);
        r.hostKey = candidates[0]?.key || [...r.players.values()][0]?.key || r.hostKey;
      }
      emitRoom(code);
    }
  });

  socket.on("disconnect", () => {
    // Mark any player using this socket as disconnected
    for (const code of Object.keys(rooms)) {
      const r = rooms[code];
      for (const p of r.players.values()) {
        if (p.socketId === socket.id) {
          p.connected = false;
          p.socketId = null;
          emitRoom(code);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
