const socket = io();

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  room: $("screen-room"),
  role: $("screen-role"),
};

function show(screenName) {
  for (const k of Object.keys(screens)) screens[k].classList.add("hidden");
  screens[screenName].classList.remove("hidden");
}

let currentRoom = null;
let myId = null;
let lastRoomState = null;

socket.on("connect", () => {
  myId = socket.id;
});

$("btn-create").onclick = () => {
  const name = $("name").value.trim();
  $("home-msg").textContent = "";

  socket.emit("room:create", { name }, (res) => {
    if (!res?.ok) return $("home-msg").textContent = res?.error || "Failed.";
    currentRoom = res.roomCode;
    $("room-code").textContent = currentRoom;
    show("room");
  });
};

$("btn-join").onclick = () => {
  const name = $("name").value.trim();
  const roomCode = $("code").value.trim();
  $("home-msg").textContent = "";

  socket.emit("room:join", { roomCode, name }, (res) => {
    if (!res?.ok) return $("home-msg").textContent = res?.error || "Failed.";
    currentRoom = res.roomCode;
    $("room-code").textContent = currentRoom;
    show("room");
  });
};

$("btn-leave").onclick = () => {
  socket.emit("room:leave");
  currentRoom = null;
  lastRoomState = null;
  $("players").innerHTML = "";
  $("room-msg").textContent = "";
  $("home-msg").textContent = "";
  show("home");
};

$("btn-start").onclick = () => {
  $("room-msg").textContent = "";
  socket.emit("game:start", { roomCode: currentRoom }, (res) => {
    if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn’t start.";
  });
};

$("btn-back").onclick = () => {
  // just UI back, game can still be running
  show("room");
};

socket.on("room:update", (state) => {
  if (!state?.roomCode) return;
  if (currentRoom && state.roomCode !== currentRoom) return;

  lastRoomState = state;
  $("room-code").textContent = state.roomCode;

  // host button
  const isHost = state.hostId === myId;
  $("btn-start").classList.toggle("hidden", !isHost || state.phase !== "lobby");

  // render players
  $("players").innerHTML = "";
  for (const p of state.players) {
    const div = document.createElement("div");
    div.className = "player";
    div.textContent = p.name + (p.id === state.hostId ? " (host)" : "");
    $("players").appendChild(div);
  }

  // if game started, keep them in room screen until role arrives
  if (state.phase === "playing") {
    $("room-msg").textContent = "Game started — check your role screen.";
  }
});

socket.on("game:role", ({ role, word }) => {
  $("role").textContent = role;
  if (word) {
    $("word").textContent = word;
    $("word-box").classList.remove("hidden");
  } else {
    $("word").textContent = "";
    $("word-box").classList.add("hidden");
  }
  show("role");
});

