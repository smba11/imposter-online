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
 *   speakerIndex: number,
 *   votes: Map(voterKey -> targetKey|null), // null = skip
 *   revealed: Set(playerKey),              // who got role reveal this game
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
  if (imp <= 0) return { over: true, winner: "CREW", reason: "imposters_eliminated" };
  if (imp >= crew) return { over: true, winner: "IMPOSTERS", reason: "imposters_majority" };
  return { over: false, winner: null, reason: null };
}

function announce(roomCode, msg) {
  io.to(roomCode).emit("game:announce", { msg, ts: Date.now() });
}

// speaker selection that respects order and alive players
function computeSpeakerFromIndex(room) {
  const aliveSet = new Set(livingKeys(room));
  if (!room.order || room.order.length === 0) return null;

  // ensure index is in range
  const base = ((room.speakerIndex || 0) % room.order.length + room.order.length) % room.order.length;

  // find next alive starting from base
  for (let step = 0; step < room.order.length; step++) {
    const idx = (base + step) % room.order.length;
    const key = room.order[idx];
    if (aliveSet.has(key)) {
      room.speakerIndex = idx; // snap to actual alive spot
      return key;
    }
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
    wordHint: r.phase === "lobby" ? null : "hidden",
    players: playersArr,
    order: r.order.map(k => {
      const p = r.players.get(k);
      return {
        key: k,
        name: p ? p.name : "Unknown",
        eliminated: r.eliminated.has(k),
        connected: p ? p.connected : false
      };
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

  // ✅ B MODE: imposters do NOT know other imposters.
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

  r.round = 1;
  r.phase = "role";
  r.word = pickRandom(WORDS);
  r.eliminated = new Set();
  r.votes = new Map();

  // once-per-game role reveal tracking
  r.revealed = new Set();

  const allKeys = [...r.players.keys()];

  // speaking order randomized once per game
  r.order = shuffle(allKeys);
  r.speakerIndex = 0;
  r.currentSpeakerKey = computeSpeakerFromIndex(r);

  // assign imposters once per game
  r.imposters = new Set();
  const impN = imposterCount(allKeys.length);
  const shuffledForRoles = shuffle(allKeys);
  for (let i = 0; i < impN; i++) r.imposters.add(shuffledForRoles[i]);

  announce(roomCode, `Game started! Role reveal time. (Round 1)`);
  emitRoom(roomCode);
}

function beginVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  r.phase = "vote";
  r.votes = new Map();

  announce(roomCode, `Voting started — everyone alive must vote (or skip).`);
  emitRoom(roomCode);
}

function finishVoting(roomCode) {
  const r = rooms[roomCode];
  if (!r || r.phase !== "vote") return;

  const alive = livingKeys(r);

  // require all alive votes recorded
  for (const k of alive) {
    if (!r.votes.has(k)) return;
  }

  // tally (skip votes are null)
  const tally = new Map(); // targetKey -> count
  for (const [voterKey, targetKey] of r.votes.entries()) {
    if (!alive.includes(voterKey)) continue;
    if (targetKey === null) continue;
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

  if (eliminatedInfo) {
    announce(roomCode, `${eliminatedInfo.name} was eliminated… they were ${eliminatedInfo.wasImposter ? "IMPOSTER" : "CREW"}.`);
  } else {
    announce(roomCode, `Tie / no elimination. Host can start next round.`);
  }

  const win = checkWin(r);

  io.to(roomCode).emit("game:results", {
    eliminated: eliminatedInfo,
    tieOrNoElim: eliminatedInfo ? false : true,
    win: win.over ? { winner: win.winner } : null
  });

  // Endgame reveal
  if (win.over) {
    const imposterNames = [...r.imposters].map(k => {
      const p = r.players.get(k);
      return { key: k, name: p ? p.name : "Unknown" };
    });

    announce(roomCode, `${win.winner} WIN! Revealing all imposters…`);
    io.to(roomCode).emit("game:win", {
      winner: win.winner, // "CREW" or "IMPOSTERS"
      reason: win.reason,
      imposters: imposterNames
    });
  }

  emitRoom(roomCode);
}

function nextRound(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;

  const win = checkWin(r);
  if (win.over) return;

  r.round += 1;
  r.votes = new Map();

  // After round 1, role reveal is NOT shown again. So go straight to discussion.
  r.phase = "discuss";

  // reset speaker for the new round
  r.speakerIndex = 0;
  r.currentSpeakerKey = computeSpeakerFromIndex(r);

  announce(roomCode, `Round ${r.round} started — discussion time.`);
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
        speakerIndex: 0,
        votes: new Map(),
        revealed: new Set(),
        players: new Map()
      };

      const r = rooms[code];
      r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });

      socket.join(code);
      announce(code, `Room created. Waiting in lobby.`);
      emitRoom(code);
      return cb?.({ ok: true, roomCode: code });
    }

    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });

    // Rejoin
    if (r.players.has(key)) {
      const p = r.players.get(key);
      p.name = cleanName;
      p.socketId = socket.id;
      p.connected = true;

      socket.join(code);
      emitRoom(code);

      // Do NOT auto-send role on rejoin (role reveal once per game)
      return cb?.({ ok: true, roomCode: code, rejoined: true });
    }

    // New join only in lobby
    if (r.phase !== "lobby") return cb?.({ ok: false, error: "Game already started." });

    r.players.set(key, { key, name: cleanName, socketId: socket.id, connected: true });
    socket.join(code);
    announce(code, `${cleanName} joined the lobby.`);
    emitRoom(code);
    cb?.({ ok: true, roomCode: code });
  });

  // Client requests its role during role phase (server enforces once-per-game)
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

    // lobby not allowed mid-game
    if (phase === "lobby" && r.phase !== "lobby") return cb?.({ ok: false, error: "Use End Game instead." });

    if (phase === "vote") {
      beginVoting(code);
      return cb?.({ ok: true });
    }

    r.phase = phase;

    if (phase === "discuss") {
      // ensure speaker exists
      if (!r.currentSpeakerKey) r.currentSpeakerKey = computeSpeakerFromIndex(r);
      announce(code, `Discussion started — host controls speakers.`);
    } else if (phase === "role") {
      announce(code, `Role reveal phase.`);
    } else if (phase === "results") {
      announce(code, `Results phase.`);
    }

    emitRoom(code);
    cb?.({ ok: true });
  });

  // Host-only: advance to next speaker during discussion
  socket.on("speaker:next", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can control speakers." });
    if (r.phase !== "discuss") return cb?.({ ok: false, error: "Not discussion phase." });
    if (!r.order || r.order.length === 0) return cb?.({ ok: false, error: "No speaking order." });

    // move index forward, then snap to next alive
    r.speakerIndex = (r.speakerIndex + 1) % r.order.length;
    r.currentSpeakerKey = computeSpeakerFromIndex(r);

    const p = r.players.get(r.currentSpeakerKey);
    announce(code, p ? `Now speaking: ${p.name}` : `Next speaker.`);
    emitRoom(code);
    cb?.({ ok: true });
  });

  // Next round — only from results (prevents weird skips)
  socket.on("round:next", ({ roomCode, playerKey }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return cb?.({ ok: false, error: "Room not found." });
    if (!isHost(r, playerKey)) return cb?.({ ok: false, error: "Only host can next round." });
    if (r.phase === "lobby") return cb?.({ ok: false, error: "Game not started." });
    if (r.phase !== "results") return cb?.({ ok: false, error: "Next Round only works from Results." });

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

    r.phase = "lobby";
    r.round = 0;
    r.word = null;
    r.imposters = new Set();
    r.eliminated = new Set();
    r.order = [];
    r.currentSpeakerKey = null;
    r.speakerIndex = 0;
    r.votes = new Map();
    r.revealed = new Set();

    announce(code, `Game ended — back to lobby.`);
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

    let target = null;
    if (String(targetKey) !== "SKIP") {
      if (!r.players.has(targetKey)) return cb?.({ ok: false, error: "Invalid target." });
      if (r.eliminated.has(targetKey)) return cb?.({ ok: false, error: "Target eliminated." });
      if (playerKey === targetKey) return cb?.({ ok: false, error: "Can't vote yourself." });
      target = targetKey;
    }

    r.votes.set(playerKey, target);

    const votedCount = alive.filter(k => r.votes.has(k)).length;
    io.to(code).emit("vote:status", { votedCount, total: alive.length });

    emitRoom(code);

    if (votedCount === alive.length) {
      announce(code, `All votes are in.`);
      finishVoting(code);
    }

    cb?.({ ok: true });
  });

  socket.on("room:leave", ({ roomCode, playerKey }) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const r = ensureRoom(code);
    if (!r) return;

      socket.leave(code); // ✅ stop receiving room broadcasts

    if (r.players.has(playerKey)) {
      const p = r.players.get(playerKey);
      p.connected = false;
      p.socketId = null;

      if (r.hostKey === playerKey) {
        const connected = [...r.players.values()].filter(pp => pp.connected);
        r.hostKey = connected[0]?.key || [...r.players.values()][0]?.key || r.hostKey;
        announce(code, `Host left — new host assigned.`);
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
