// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * rooms = {
 *   ABCD: {
 *     hostId: "socketId",
 *     players: [{ id, name }],
 *     phase: "lobby" | "playing",
 *     word: "Pizza",
 *     imposterId: "socketId"
 *   }
 * }
 */
const rooms = Object.create(null);

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("room:update", {
    roomCode,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WORDS = [
  "Pizza", "Basketball", "School", "Netflix", "Soccer",
  "Seattle", "Airplane", "Coffee", "Concert", "Robots"
];

io.on("connection", (socket) => {
  // Create room
  socket.on("room:create", ({ name }, cb) => {
    const cleanName = String(name || "").trim().slice(0, 20);
    if (!cleanName) return cb?.({ ok: false, error: "Name required." });

    let code = makeRoomCode();
    while (rooms[code]) code = makeRoomCode();

    rooms[code] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: cleanName }],
      phase: "lobby",
      word: null,
      imposterId: null
    };

    socket.join(code);
    broadcastRoom(code);
    cb?.({ ok: true, roomCode: code });
  });

  // Join room
  socket.on("room:join", ({ roomCode, name }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms[code];
    const cleanName = String(name || "").trim().slice(0, 20);

    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (!cleanName) return cb?.({ ok: false, error: "Name required." });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Game already started." });

    // prevent duplicate id (shouldn’t happen) + name collisions (optional)
    if (room.players.some(p => p.id === socket.id)) {
      return cb?.({ ok: true, roomCode: code });
    }

    room.players.push({ id: socket.id, name: cleanName });
    socket.join(code);
    broadcastRoom(code);
    cb?.({ ok: true, roomCode: code });
  });

  // Host starts game
  socket.on("game:start", ({ roomCode }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (socket.id !== room.hostId) return cb?.({ ok: false, error: "Only host can start." });
    if (room.players.length < 3) return cb?.({ ok: false, error: "Need at least 3 players." });

    room.phase = "playing";
    room.word = pickRandom(WORDS);

    // pick imposter
    const imposter = pickRandom(room.players);
    room.imposterId = imposter.id;

    // Send private role to each socket
    for (const p of room.players) {
      const isImposter = p.id === room.imposterId;
      io.to(p.id).emit("game:role", {
        role: isImposter ? "IMPOSTER" : "CREW",
        // imposter doesn't get the word
        word: isImposter ? null : room.word
      });
    }

    broadcastRoom(code);
    cb?.({ ok: true });
  });

  // Leave room (client button) OR handle disconnect
  function removeFromRooms() {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      room.players.splice(idx, 1);

      // if host left, promote first remaining player as host
      if (room.hostId === socket.id) {
        room.hostId = room.players[0]?.id ?? null;
      }

      // delete room if empty
      if (room.players.length === 0) {
        delete rooms[code];
        continue;
      }

      // if game was playing and someone left, keep simple for MVP
      broadcastRoom(code);
    }
  }

  socket.on("room:leave", () => {
    removeFromRooms();
  });

  socket.on("disconnect", () => {
    removeFromRooms();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));

