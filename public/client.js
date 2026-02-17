// public/client.js
console.log("CLIENT VERSION: v3 manual phases loaded");

const socket = io();
const $ = (id) => document.getElementById(id);

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

const screens = {
  home: $("screen-home"),
  room: $("screen-room"),
  role: $("screen-role"),
};

function show(screenName) {
  for (const k of Object.keys(screens)) screens[k].classList.add("hidden");
  screens[screenName].classList.remove("hidden");
}

/** Home actions */
$("btn-create").onclick = () => {
  const name = $("name").value.trim();
  $("home-msg").textContent = "";

  socket.emit("room:joinOrCreate", { create: true, name, playerKey }, (res) => {
    if (!res?.ok) return ($("home-msg").textContent = res?.error || "Failed.");
    currentRoom = res.roomCode;
    $("room-code").textContent = currentRoom;
    show("room");
  });
};

$("btn-join").onclick = () => {
  const name = $("name").value.trim();
  const roomCode = $("code").value.trim();
  $("home-msg").textContent = "";

  socket.emit("room:joinOrCreate", { create: false, roomCode, name, playerKey }, (res) => {
    if (!res?.ok) return ($("home-msg").textContent = res?.error || "Failed.");
    currentRoom = res.roomCode;
    $("room-code").textContent = currentRoom;
    show("room");
  });
};

$("btn-leave").onclick = () => {
  if (currentRoom) socket.emit("room:leave", { roomCode: currentRoom, playerKey });
  currentRoom = null;
  lastState = null;
  $("players").innerHTML = "";
  $("room-msg").textContent = "";
  $("home-msg").textContent = "";
  show("home");
};

$("btn-back").onclick = () => show("room");

/** Host button is dynamic now */
function setHostButton(text, onClick) {
  const btn = $("btn-start");
  btn.textContent = text;
  btn.onclick = onClick;
  btn.classList.remove("hidden");
}

function hideHostButton() {
  $("btn-start").classList.add("hidden");
}

function phaseLabel(phase) {
  return (
    phase === "lobby" ? "Lobby" :
    phase === "role" ? "Role Reveal" :
    phase === "discuss" ? "Discussion" :
    phase === "vote" ? "Voting" :
    phase === "results" ? "Results" : phase
  );
}

function roomShareLink(code) {
  return `${location.origin}?room=${code}`;
}

function renderRoom(state) {
  lastState = state;

  const amHost = state.hostKey === playerKey;

  // message area
  if (state.phase === "lobby") {
    $("room-msg").textContent = `Share link: ${roomShareLink(state.roomCode)}`;
  } else {
    $("room-msg").textContent = `Round ${state.round} • Phase: ${phaseLabel(state.phase)}`;
  }

  // host controls
  if (amHost) {
    if (state.phase === "lobby") {
      setHostButton("Start Game (Host)", () => {
        $("room-msg").textContent = "";
        socket.emit("game:start", { roomCode: state.roomCode, playerKey }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn’t start.";
        });
      });
    } else if (state.phase === "role") {
      setHostButton("Go to Discussion", () => {
        socket.emit("phase:set", { roomCode: state.roomCode, playerKey, phase: "discuss" }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn't change phase.";
        });
      });
    } else if (state.phase === "discuss") {
      setHostButton("Go to Voting", () => {
        socket.emit("phase:set", { roomCode: state.roomCode, playerKey, phase: "vote" }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn't change phase.";
        });
      });
    } else if (state.phase === "vote") {
      setHostButton("Show Results", () => {
        socket.emit("phase:set", { roomCode: state.roomCode, playerKey, phase: "results" }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn't show results.";
        });
      });
    } else if (state.phase === "results") {
      setHostButton("Next Round", () => {
        socket.emit("round:next", { roomCode: state.roomCode, playerKey }, (res) => {
          if (!res?.ok) $("room-msg").textContent = res?.error || "Couldn't next round.";
        });
      });
    } else {
      hideHostButton();
    }
  } else {
    hideHostButton();
  }

  // render players (click to vote during vote phase)
  $("players").innerHTML = "";

  const me = state.players.find(p => p.key === playerKey);
  const iAmEliminated = !!me?.eliminated;

  for (const p of state.players) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player";

    const tags = [];
    if (p.key === state.hostKey) tags.push("host");
    if (!p.connected) tags.push("offline");
    if (p.eliminated) tags.push("out");
    if (p.key === playerKey) tags.push("you");

    btn.textContent = `${p.name}${tags.length ? " • " + tags.join(", ") : ""}`;

    const canVote =
      state.phase === "vote" &&
      !iAmEliminated &&
      !p.eliminated &&
      p.key !== playerKey;

    if (canVote) {
      btn.onclick = () => {
        socket.emit(
          "vote:cast",
          { roomCode: state.roomCode, playerKey, targetKey: p.key },
          (res) => {
            if (!res?.ok) $("room-msg").textContent = res?.error || "Vote failed.";
            else $("room-msg").textContent = `Voted for ${p.name}.`;
          }
        );
      };
    } else {
      btn.onclick = null;
    }

    $("players").appendChild(btn);
  }
}

/** Socket events */
socket.on("room:update", (state) => {
  if (!state?.roomCode) return;
  if (currentRoom && state.roomCode !== currentRoom) return;

  currentRoom = state.roomCode;
  $("room-code").textContent = state.roomCode;
  renderRoom(state);
  show("room");
});

socket.on("game:role", ({ role, word, round }) => {
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
  if (!lastState) return;
  if (lastState.phase === "vote") {
    $("room-msg").textContent = `Round ${lastState.round} • Voting • ${votedCount}/${total} votes in`;
  }
});

socket.on("game:results", ({ eliminated, win }) => {
  if (eliminated) {
    const roleTxt = eliminated.wasImposter ? "IMPOSTER" : "CREW";
    $("room-msg").textContent = `${eliminated.name} was voted out (${roleTxt}).`;
  } else {
    $("room-msg").textContent = `No one eliminated (tie / no votes).`;
  }

  if (win?.winner) {
    $("room-msg").textContent += ` Winner: ${win.winner}.`;
  }
});

/** Auto-fill room code from URL (?room=ABCD) */
(function bootstrapRoomFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) $("code").value = code.toUpperCase().slice(0, 4);
})();
