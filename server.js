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
 *   order: string[],
 *   currentSpeakerKey: string|null,
 *   votes: Map(voterKey -> targetKey|null), // null = skip
 *   revealed: Set(playerKey),              // ✅ who has received role reveal this game
 *   speakerIndex: number,                  // (reserved for later)
 *   players: Map(playerKey -> { key, name, socketId|null, connected:boolean })
 * }
 */
const rooms = Object.create(null);

const WORDS = [
  "Pizza", "Basketball", "School", "Netflix", "Soccer",
  "Seattle", "Airplane", "Coffee", "Concert", "Robots"
];

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Your scaling rule: 3->1, 5->2, 7->3...
function imposterCount(n) {
  return Math.max(1, Math.floor((n - 1) / 2));
}

function ensureRoom(code) {
  return rooms[code] || null;
}

function isHost(room, playerKey) {
  return room.hostKey === playerKey;
}

function livingKeys(room) {
  return [...room.players.keys()].filter(k => !room.eliminated.has(k));
}

function livingCrewCount(room) {
  let crew = 0;
  for (const k of livingKeys(room)) if (!room.imposters.has(k)) crew++;
  return crew;
}

function livingImposterCount(room) {
  let imp = 0;
  for (const k of livingKeys(room)) if (room.imposters.has(k)) imp++;
  return imp;
}

function checkWin(room) {
  const imp = livingImposterCount(room);
  const crew = livingCrewCount(room);
  if (imp <= 0) return { over: true, winner: "CREW" };
  if (imp >= crew) return { over: true, winner: "IMPOSTERS" };
  return { over: false, winner: null };
}

// Fixed order, but current speaker rotates each round and skips eliminated
function computeCurrentSpeaker(room) {
  const aliveSet = new Set(livingKeys(room));
  if (room.order.length === 0) return null;

  // rotate each round: offset = (round - 1)
  const startIndex = (Math.max(1, room.round) - 1) % room.order.length;

  for (let step = 0; step < room.order.length; step++) {
    const idx = (startIndex + step) % room.order.length;
    const key = room.order[idx];
    if (aliveSet.has(key)) return key;
  }
  return null;
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

  const alive = livingKeys(r);
  const votedCount = alive.filter(k => r.votes.has(k)).length;

  return {
    roomCode,
    phase: r.phase,
    round: r.round,
    hostKey: r.hostKey,
    wordHint: r.phase === "lobby" ? null : "hidden", // never expose word
    players: playersArr,
    order: r.order.map(k => {
      const p = r.players.get(k);
      return { key: k, name: p ? p.name : "Unknown", eliminated: r.eliminated.has(k), connected: p ? p.connected : false };
    }),
    currentSpeakerKey: r.currentSpeakerKey,
    voteStatus: r.phase === "vote" ? { votedCount, total: alive.length } : null
  };
}

function emitRoom(roomCode) {
  const state = roomPublicState(roomCode);
  if (!state) return;
  io.to(roomCode).emit("room:update", state);
}

function sendRoleToPlayer(roomCode, playerKey) {
  const r = rooms[roomCode];
  if (!r) return;
  const p = r.players.get(playerKey);
  if (!p || !p.socketId) return;
  if (r.eliminated.has(playerKey)) return;

  const isImp = r.imposters.has(playerKey);
  io.to(p.socketId).emit("game:role", {
    roomCode,
    role: isImp ? "IMPOSTER" : "CREW",
    word: isImp ? null : r.word,
    round: r.round
  });
}

function startGame(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  // Reset game
  r.round = 1;
  r.phase = "role";
  r.word = pickRandom(WORDS);
  r.eliminated = new Set();
  r.votes = new Map();

  // ✅ once-per-game role reveal tracking
  r.revealed = new Set();

  // (reserved for later)
  r.speakerIndex = 0;

  // Fix speaking order once per game (randomized once)
  const allKeys = [...r.players.keys()];
  r.order = shuffle(allKeys);

  // Assign imposters once per game (fixed roles)
  r.imposters = new Set();
  const n = allKeys.length;
  const impN = imposterCount(n);
  const shuffledForRoles = shuffle(allKeys);
  for (let i = 0; i < impN; i++) r.imposters.add(shuffledForRoles[i]);

  // Compute current speaker for round 1
  r.currentSpeakerKey = computeCurrentSpeaker(r);

  // ❌ DO NOT auto-send roles (client requests once during role phase)
  emitRoom(roomCode);
}

function beginVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  r.phase = "vote";
  r.votes = new Map(); // clear previous votes
  emitRoom(roomCode);
}

function finishVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  if (r.phase !== "vote") return;

  const alive = livingKeys(r);

  // REQUIRE everyone alive to have a vote recorded (vote or skip)
  for (const k of alive) {
    if (!r.votes.has(k)) return; // not done yet
  }

  // tally votes (skip votes are null and are ignored)
  const tally = new Map(); // targetKey -> count
  for (const [voterKey, targetKey] of r.votes.entries()) {
    if (!alive.includes(voterKey)) continue;
    if (targetKey === null) continue; // skip
    if (!r.players.has(targetKey)) continue;
    if (r.eliminated.has(targetKey)) continue;
    tally.set(targetKey, (tally.get(targetKey) || 0) + 1);
  }

  let eliminatedKey = null;

  if (tally.size > 0) {
    let max = 0;
    for (const c of tally.values()) max = Math.max(max, c);
    const top = [...tally.entries()].filter(([, c]) => c === max).map(([k]) => k);

    // tie => no elim
    if (top.length === 1 && max > 0) {
      eliminatedKey = top[0];
      r.eliminated.add(eliminatedKey);
    }
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
    tieOrNoElim: eliminatedInfo ? false : true,
    win: win.over ? { winner: win.winner } : null
  });

  emitRoom(roomCode);
}

function nextRound(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  const win = checkWin(r);
  if (win.over) return;

  r.round += 1;
  r.phase = "role";
  r.votes = new Map();
  r.currentSpeakerKey = computeCurrentSpeaker(r);

  // ❌ Do not resend roles each round (roles are fixed; reveal only once per game)
  emitRoom(roomCode);
}

io.on("connection", (socket) => {
  // Join or create (rejoin-safe identity)
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
        order: [],
        currentSpeakerKey: null,
        votes: new Map(),
        revealed: new Set(),   // ✅
        speakerIndex: 0,       // (reserved)
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

    // Rejoin (works mid-game)
    if (r.players.has(key)) {
      const p = r.players.get(key);
      p.name = cleanName;
      p.socketId = socket.id;
      p.connected = true;

      socket.join(code);
      emitRoom(code);

      // ✅ Do NOT auto-send role on rejoin (once per game)
      return cb?.({ ok: true, roomCode: code, rejoined: true });
    }

    // New join only in lobby
    if (r.phase !== "lobby") return cb?.({ ok: false, error: "Game already started." });

    r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });
    socket.join(code);
    emitRoom(code);
    cb?.({ ok: true, roomCode: code });
  });

  // ✅ Client requests its role during role phase (server enforces once-per-game)
  socket.on("role:request", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });

    if (!r.players.has(playerKey)) return cb?.({ ok: false, error: "Unknown player." });
    if (r.phase !== "role") return cb?.({ ok: false, error: "Not role phase." });
    if (r.eliminated.has(playerKey)) return cb?.({ ok: false, error: "Eliminated." });

    if (!r.revealed) r.revealed = new Set();
    if (r.revealed.has(playerKey)) return cb?.({ ok: true, already: true });

    r.revealed.add(playerKey);
    sendRoleToPlayer(code, playerKey);
    cb?.({ ok: true });
  });

  socket.on("game:start", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can start." });
    if (r.players.size < 3) return cb?.({ ok: false, error: "Need at least 3 players." });

    startGame(code);
    cb?.({ ok: true });
  });

  // Host phase controls (manual pacing)
  socket.on("phase:set", ({ roomCode, playerKey, phase }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can control phases." });

    const allowed = new Set(["lobby", "role", "discuss", "vote", "results"]);
    if (!allowed.has(phase)) return cb?.({ ok: false, error: "Bad phase." });

    // lobby not allowed mid-game (keep it simple)
    if (phase === "lobby" && r.phase !== "lobby") return cb?.({ ok: false, error: "Use End Game instead." });

    if (phase === "vote") {
      beginVoting(code);
      return cb?.({ ok: true });
    }

    // role/discuss/results just set phase
    r.phase = phase;
    emitRoom(code);
    cb?.({ ok: true });
  });

  socket.on("round:next", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can next round." });
    if (r.phase === "lobby") return cb?.({ ok: false, error: "Game not started." });

    const win = checkWin(r);
    if (win.over) return cb?.({ ok: false, error: "Game is over. End it." });

    nextRound(code);
    cb?.({ ok: true });
  });

  socket.on("game:end", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can end." });

    // reset back to lobby but keep players
    r.phase = "lobby";
    r.round = 0;
    r.word = null;
    r.imposters = new Set();
    r.eliminated = new Set();
    r.order = [];
    r.currentSpeakerKey = null;
    r.votes = new Map();
    r.revealed = new Set(); // ✅ reset for next game
    r.speakerIndex = 0;

    emitRoom(code);
    cb?.({ ok: true });
  });

  // Voting: targetKey can be a playerKey or "SKIP"
  socket.on("vote:cast", ({ roomCode, playerKey, targetKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (r.phase !== "vote") return cb?.({ ok: false, error: "Not voting phase." });

    if (!r.players.has(playerKey)) return cb?.({ ok: false, error: "Unknown player." });
    if (r.eliminated.has(playerKey)) return cb?.({ ok: false, error: "You are eliminated." });

    const alive = livingKeys(r);

    // Interpret skip
    let target = null;
    if (String(targetKey) !== "SKIP") {
      if (!r.players.has(targetKey)) return cb?.({ ok: false, error: "Invalid target." });
      if (r.eliminated.has(targetKey)) return cb?.({ ok: false, error: "Target eliminated." });
      if (playerKey === targetKey) return cb?.({ ok: false, error: "Can't vote yourself." });
      target = targetKey;
    }

    r.votes.set(playerKey, target);

    // broadcast progress
    const votedCount = alive.filter(k => r.votes.has(k)).length;
    io.to(code).emit("vote:status", { votedCount, total: alive.length });

    emitRoom(code);

    // Only proceed once EVERY alive player voted (including skip)
    if (votedCount === alive.length) {
      finishVoting(code);
    }

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

      // If host leaves, promote first connected player (or anyone)
      if (r.hostKey === playerKey) {
        const connected = [...r.players.values()].filter(pp => pp.connected);
        r.hostKey = connected[0]?.key || [...r.players.values()][0]?.key || r.hostKey;
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
