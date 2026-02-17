// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * rooms[code] = {
 *   hostKey: string,
 *   phase: "lobby"|"role"|"discuss"|"vote"|"results",
 *   round: number,
 *   word: string|null,
 *   imposters: Set(playerKey),
 *   eliminated: Set(playerKey),
 *   votes: Map(voterKey -> targetKey),
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

// Your scaling rule examples:
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
  }));

  return {
    roomCode,
    phase: r.phase,
    round: r.round,
    hostKey: r.hostKey,
    players: playersArr,
  };
}

function emitRoom(roomCode) {
  const state = roomPublicState(roomCode);
  if (!state) return;
  io.to(roomCode).emit("room:update", state);
}

function ensureRoom(roomCode) {
  return rooms[roomCode] || null;
}

function isHost(room, playerKey) {
  return room.hostKey === playerKey;
}

function livingPlayers(room) {
  return [...room.players.values()].filter(p => !room.eliminated.has(p.key));
}

function livingCrewCount(room) {
  let crew = 0;
  for (const p of livingPlayers(room)) if (!room.imposters.has(p.key)) crew++;
  return crew;
}

function livingImposterCount(room) {
  let imp = 0;
  for (const p of livingPlayers(room)) if (room.imposters.has(p.key)) imp++;
  return imp;
}

function checkWin(room) {
  const imp = livingImposterCount(room);
  const crew = livingCrewCount(room);
  if (imp <= 0) return { over: true, winner: "CREW" };
  if (imp >= crew) return { over: true, winner: "IMPOSTERS" };
  return { over: false, winner: null };
}

function assignRoles(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  // Send private role to each connected living player
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
}

function startGame(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  // reset
  r.round = 0;
  r.phase = "role";
  r.eliminated = new Set();
  r.votes = new Map();

  // pick word and imposters
  r.word = pickRandom(WORDS);
  r.imposters = new Set();

  const living = livingPlayers(r);
  const n = living.length;
  const impN = imposterCount(n);

  const shuffledKeys = living.map(p => p.key).sort(() => Math.random() - 0.5);
  for (let i = 0; i < impN; i++) r.imposters.add(shuffledKeys[i]);

  // start round 1 role reveal
  r.round = 1;
  r.phase = "role";

  assignRoles(roomCode);
  emitRoom(roomCode);
}

function nextRound(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  r.round += 1;
  r.phase = "role";
  r.votes = new Map();

  assignRoles(roomCode);
  emitRoom(roomCode);
}

function finishVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  if (r.phase !== "vote") return;

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
}

io.on("connection", (socket) => {
  // Join or create with rejoin identity
  socket.on("room:joinOrCreate", ({ roomCode, name, playerKey, create }, cb) => {
    const cleanName = String(name || "").trim().slice(0, 20);
    const key = String(playerKey || "").trim();

    if (!cleanName) return cb?.({ ok: false, error: "Name required." });
    if (!key) return cb?.({ ok: false, error: "playerKey required." });

    // CREATE
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
        players: new Map()
      };

      const r = rooms[code];
      r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });

      socket.join(code);
      emitRoom(code);
      return cb?.({ ok: true, roomCode: code });
    }

    // JOIN
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });

    // REJOIN
    if (r.players.has(key)) {
      const p = r.players.get(key);
      p.name = cleanName;
      p.socketId = socket.id;
      p.connected = true;

      socket.join(code);
      emitRoom(code);

      // if currently in role phase, resend role to rejoined player (nice UX)
      if (r.phase !== "lobby" && !r.eliminated.has(key)) {
        const isImp = r.imposters.has(key);
        io.to(socket.id).emit("game:role", {
          role: isImp ? "IMPOSTER" : "CREW",
          word: isImp ? null : r.word,
          round: r.round
        });
      }

      return cb?.({ ok: true, roomCode: code, rejoined: true });
    }

    // new join only allowed in lobby
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

  // Host controls phases manually
  socket.on("phase:set", ({ roomCode, playerKey, phase }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can control phases." });

    const allowed = new Set(["lobby", "role", "discuss", "vote", "results"]);
    if (!allowed.has(phase)) return cb?.({ ok: false, error: "Bad phase." });

    // If moving to results from vote, finish vote (elimination + win check)
    if (r.phase === "vote" && phase === "results") {
      finishVoting(code);
      return cb?.({ ok: true });
    }

    r.phase = phase;
    // If host sets phase to "role", resend roles (useful if someone missed it)
    if (phase === "role") assignRoles(code);

    emitRoom(code);
    cb?.({ ok: true });
  });

  // Host starts the next round cleanly
  socket.on("round:next", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can next round." });
    if (r.phase === "lobby") return cb?.({ ok: false, error: "Game not started." });

    const win = checkWin(r);
    if (win.over) {
      // reset back to lobby if already ended
      r.phase = "lobby";
      r.word = null;
      r.imposters = new Set();
      r.eliminated = new Set();
      r.votes = new Map();
      r.round = 0;
      emitRoom(code);
      return cb?.({ ok: true, ended: true });
    }

    nextRound(code);
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

    if (playerKey === targetKey) return cb?.({ ok: false, error: "Can't vote yourself." });

    r.votes.set(playerKey, targetKey);

    // UX: broadcast vote progress only
    const living = livingPlayers(r);
    const votedCount = [...r.votes.keys()].filter(k => !r.eliminated.has(k)).length;
    io.to(code).emit("vote:status", { votedCount, total: living.length });

    // optional: if everyone voted, host can still choose when to show results
    // (we do NOT auto-finish)
    emitRoom(code);
    cb?.({ ok: true });
  });

  socket.on("room:leave", ({ roomCode, playerKey }) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return;

    if (r.players.has(playerKey)) {
      const p = r.players.get(playerKey);
      p.connected = false;
      p.socketId = null;

      if (r.hostKey === playerKey) {
        const candidates = [...r.players.values()].filter(pp => pp.connected);
        r.hostKey = candidates[0]?.key || [...r.players.values()][0]?.key || r.hostKey;
      }

      emitRoom(code);
    }
  });

  socket.on("disconnect", () => {
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
