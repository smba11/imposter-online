// public/client.js
console.log("CLIENT VERSION: v2 rounds + voting loaded");
const socket = io();
const $ = (id) => document.getElementById(id);

let mySocketId = null;
socket.on("connect", () => (mySocketId = socket.id));

/** Rejoin identity */
function getPlayerKey() {
  let k = localStorage.getItem("playerKey");
  if (!k) {
    k = crypto.randomUUID();
    localStorage.setItem("playerKey", k);
  }
  return k;
}
const playerKey = getPlayerKey();

let currentRoom = null;
let lastState = null;
let myRole = null; // { role, word, round }

/** Screens */
const screens = {
  home: $("screen-home"),
  room: $("screen-room"),
  role: $("screen-role"),
};
function show(screenName) {
  for (const k of Object.keys(screens)) screens[k].classList.add("hidden");
  screens[screenName].classList.remove("hidden");
}

/** Small helpers */
function msToClock(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Home actions */
$("btn-create").onclick = () => {
  const name = $("name").value.trim();
  $("home-msg").textContent = "";

  socket.emit(
    "room:joinOrCreate",
    { create: true, name, playerKey },
    (res) => {
      if (!res?.ok) return ($("home-msg").textContent = res?.error || "Failed.");
      currentRoom = res.roomCode;
      $("room-code").textContent = currentRoom;
      show("room");
    }
  );
};

$("btn-join").onclick = () => {
  const name = $("name").value.trim();
  const roomCode = $("code").value.trim();
  $("home-msg").textContent = "";

  socket.emit(
    "room:joinOrCreate",
    { create: false, roomCode, name, playerKey },
    (res) => {
      if (!res?.ok) return ($("home-msg").textContent = res?.error || "Failed.");
      currentRoom = res.roomCode;
      $("room-code").textContent = currentRoom;
      show("room");
    }
  );
};

$("btn-leave").onclick = () => {
  if (currentRoom) socket.emit("room:leave", { roomCode: currentRoom, playerKey });
  currentRoom = null;
  lastState = null;
  myRole = null;
  $("players").innerHTML = "";
  $("room-msg").textContent = "";
  $("home-msg").textContent = "";
  // clear vote area if you add it later
  show("home");
};

$("btn-start").onclick = () => {
  $("room-msg").textContent = "";
  socket.emit("game:start", { roomCode: currentRoom, playerKey }, (res) => {
    if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn’t start.";
  });
};

$("btn-back").onclick = () => show("room");

/** Optional: quick copy room link UX */
function roomShareLink(code) {
  return `${location.origin}?room=${code}`;
}

/** Room UI rendering */
function renderRoom(state) {
  lastState = state;

  // Host start button visibility
  const amHost = state.hostKey === playerKey;
  $("btn-start").classList.toggle("hidden", !(amHost && state.phase === "lobby"));

  // Phase/timer message (light UX without changing HTML yet)
  const phaseLabel =
    state.phase === "lobby" ? "Lobby" :
    state.phase === "role" ? "Role Reveal" :
    state.phase === "discuss" ? "Discussion" :
    state.phase === "vote" ? "Voting" :
    state.phase === "results" ? "Results" : state.phase;

  let timerText = "";
  if (state.timer?.remainingMs != null) {
    timerText = ` • ${msToClock(state.timer.remainingMs)}`;
  }

  $("room-msg").textContent =
    state.phase === "lobby"
      ? `Share link: ${roomShareLink(state.roomCode)}`
      : `Phase: ${phaseLabel}${timerText}`;

  // Render players as clickable cards during vote phase (UX)
  $("players").innerHTML = "";
  for (const p of state.players) {
    const div = document.createElement("button");
    div.type = "button";
    div.className = "player";

    const tags = [];
    if (p.key === state.hostKey) tags.push("host");
    if (!p.connected) tags.push("offline");
    if (p.eliminated) tags.push("out");
    if (p.key === playerKey) tags.push("you");

    div.textContent = `${p.name}${tags.length ? " • " + tags.join(", ") : ""}`;

    const canVote =
      state.phase === "vote" &&
      !p.eliminated &&
      p.key !== playerKey &&
      !state.players.find(x => x.key === playerKey)?.eliminated;

    // During vote phase, clicking casts vote
    if (canVote) {
      div.style.cursor = "pointer";
      div.onclick = () => {
        socket.emit("vote:cast", { roomCode: state.roomCode, playerKey, targetKey: p.key }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Vote failed.";
          else $("room-msg").textContent = `Voted for ${p.name}.`;
        });
      };
    } else {
      div.onclick = null;
    }

    $("players").appendChild(div);
  }
}

/** Socket events */
socket.on("room:update", (state) => {
  if (!state?.roomCode) return;
  if (currentRoom && state.roomCode !== currentRoom) return;

  currentRoom = state.roomCode;
  $("room-code").textContent = state.roomCode;
  renderRoom(state);

  // If role reveal phase starts, user will get game:role too
});

socket.on("game:role", ({ role, word, round }) => {
  myRole = { role, word, round };
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

socket.on("vote:status", ({ votedCount, total }) => {
  // simple UX feedback in msg line
  if (!lastState) return;
  if (lastState.phase === "vote") {
    $("room-msg").textContent = `Voting: ${votedCount}/${total} votes in • ${$("room-msg").textContent.split("•").pop().trim()}`;
  }
});

socket.on("game:results", ({ eliminated, win }) => {
  // quick results feedback
  if (eliminated) {
    const roleTxt = eliminated.wasImposter ? "IMPOSTER" : "CREW";
    $("room-msg").textContent = `${eliminated.name} was voted out (${roleTxt}).`;
  } else {
    $("room-msg").textContent = `No one eliminated (tie / no votes).`;
  }

  if (win?.winner) {
    $("room-msg").textContent += `  Winner: ${win.winner}.`;
  }

  // stay on room screen; role screen can be reopened manually
  show("room");
});

/** Auto-fill room code from URL (?room=ABCD) */
(function bootstrapRoomFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) $("code").value = code.toUpperCase().slice(0, 4);
})();


