// public/client.js
console.log("CLIENT VERSION: perfect spec loaded");

const socket = io();
const $ = (id) => document.getElementById(id);

// doesn’t crash the whole file if an element is missing
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
function closeReveal() {
  const overlay = document.getElementById("reveal");
  if (overlay) overlay.classList.add("hidden");
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-closeReveal");
  if (btn) btn.addEventListener("click", closeReveal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeReveal();
  });
});

  // ✅ Click outside the card to close (always gives an escape route)
  const reveal = document.getElementById("reveal");
  if (reveal) {
    reveal.addEventListener("click", (e) => {
      if (e.target === reveal) closeReveal();
    });
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

// Rejoin identity
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
let lastRolePayload = null;

socket.on("connect", () => {
  setText("conn", "Online");
  $("conn")?.classList.remove("bad");
});

socket.on("disconnect", () => {
  setText("conn", "Offline");
  $("conn")?.classList.add("bad");
});

// Screens
const screens = {
  home: $("screen-home"),
  room: $("screen-room"),
};
function show(screenName) {
  for (const k of Object.keys(screens)) screens[k].classList.add("hidden");
  screens[screenName].classList.remove("hidden");
}

// Toast
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// Role reveal overlay
function openReveal(rolePayload) {
  lastRolePayload = rolePayload;

  $("reveal").classList.remove("hidden");
  $("revealTap").classList.remove("hidden");
  $("revealInfo").classList.add("hidden");

  $("revealRole").textContent = rolePayload.role;

  if (rolePayload.word) {
    $("revealWordWrap").classList.remove("hidden");
    $("revealWord").textContent = rolePayload.word;
  } else {
    $("revealWordWrap").classList.add("hidden");
    $("revealWord").textContent = "";
  }
}

$("revealTap").onclick = () => {
  $("revealTap").classList.add("hidden");
  $("revealInfo").classList.remove("hidden");

  // color vibe
  const r = lastRolePayload?.role;
  $("revealRole").classList.toggle("imposter", r === "IMPOSTER");
};



// Join/create actions
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
  $("order").innerHTML = "";
  $("voteTargets").innerHTML = "";
  $("votePanel").classList.add("hidden");
  show("home");
};

$("btn-copy").onclick = async () => {
  if (!currentRoom) return;
  const link = `${location.origin}?room=${currentRoom}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Room link copied ✅");
  } catch {
    toast("Couldn’t copy link (browser blocked)");
  }
};

// Voting UI
$("btn-skip").onclick = () => {
  if (!lastState || lastState.phase !== "vote") return;
  socket.emit("vote:cast", { roomCode: lastState.roomCode, playerKey, targetKey: "SKIP" }, (res) => {
    if (!res?.ok) toast(res?.error || "Skip failed");
    else toast("You skipped.");
  });
};

function render(state) {
  lastState = state;

  $("room-code").textContent = state.roomCode;
  $("round").textContent = String(state.round || 0);
  $("phase").textContent = phaseLabel(state.phase);

  // Host controls
  const amHost = state.hostKey === playerKey;
  $("btn-host").classList.toggle("hidden", !amHost);
  $("btn-end").classList.toggle("hidden", !(amHost && state.phase !== "lobby"));

  $("btn-end").onclick = () => {
    socket.emit("game:end", { roomCode: state.roomCode, playerKey }, (res) => {
      if (!res?.ok) toast(res?.error || "Couldn’t end.");
    });
  };

  const hostBtn = $("btn-host");
  hostBtn.onclick = null;

  if (amHost) {
    if (state.phase === "lobby") {
      hostBtn.textContent = "Start Game";
      hostBtn.onclick = () => {
        socket.emit("game:start", { roomCode: state.roomCode, playerKey }, (res) => {
          if (!res?.ok) toast(res?.error || "Couldn’t start.");
        });
      };
    } else if (state.phase === "role") {
      hostBtn.textContent = "Start Discussion";
      hostBtn.onclick = () => socket.emit("phase:set", { roomCode: state.roomCode, playerKey, phase: "discuss" }, () => {});
    } else if (state.phase === "discuss") {
      hostBtn.textContent = "Start Voting";
      hostBtn.onclick = () => socket.emit("phase:set", { roomCode: state.roomCode, playerKey, phase: "vote" }, () => {});
    } else if (state.phase === "vote") {
      hostBtn.textContent = "Waiting for votes…";
      hostBtn.onclick = () => toast("Everyone must vote (or skip).");
    } else if (state.phase === "results") {
      hostBtn.textContent = "Next Round";
      hostBtn.onclick = () => socket.emit("round:next", { roomCode: state.roomCode, playerKey }, (res) => {
        if (!res?.ok) toast(res?.error || "Couldn’t next round.");
      });
    } else {
      hostBtn.textContent = "Host";
    }
  }

  // Players list
  $("players").innerHTML = "";
  for (const p of state.players) {
    const div = document.createElement("div");
    div.className = "playerRow";

    const name = document.createElement("div");
    name.className = "pName";
    name.textContent = p.name;

    const meta = document.createElement("div");
    meta.className = "pMeta";

    const tags = [];
    if (p.key === state.hostKey) tags.push("Host");
    if (p.key === playerKey) tags.push("You");
    if (!p.connected) tags.push("Offline");
    if (p.eliminated) tags.push("Eliminated");
    meta.textContent = tags.join(" • ");

    div.appendChild(name);
    div.appendChild(meta);

    $("players").appendChild(div);
  }

  // Speaking order
  $("order").innerHTML = "";
  for (const o of state.order || []) {
    const row = document.createElement("div");
    row.className = "orderRow";

    const left = document.createElement("div");
    left.textContent = o.name;

    const right = document.createElement("div");
    right.className = "orderMeta";
    const badges = [];
    if (o.key === state.currentSpeakerKey) badges.push("Speaking");
    if (o.eliminated) badges.push("Out");
    if (!o.connected) badges.push("Offline");
    right.textContent = badges.join(" • ");

    if (o.key === state.currentSpeakerKey) row.classList.add("active");
    if (o.eliminated) row.classList.add("out");

    row.appendChild(left);
    row.appendChild(right);
    $("order").appendChild(row);
  }

  // Vote panel
  if (state.phase === "vote") {
    $("votePanel").classList.remove("hidden");

    const me = state.players.find(p => p.key === playerKey);
    const iAmOut = !!me?.eliminated;

    // status
    const vs = state.voteStatus || { votedCount: 0, total: 0 };
    $("voteStatus").textContent = `${vs.votedCount}/${vs.total} voted`;
    if (amHost) {
      $("btn-host").textContent = vs.votedCount === vs.total ? "Votes complete…" : "Waiting for votes…";
    }

    // targets
    $("voteTargets").innerHTML = "";
    for (const p of state.players) {
      if (p.eliminated) continue;
      if (p.key === playerKey) continue;

      const btn = document.createElement("button");
      btn.className = "voteBtn";
      btn.textContent = `Vote ${p.name}`;
      btn.disabled = iAmOut;

      btn.onclick = () => {
        socket.emit("vote:cast", { roomCode: state.roomCode, playerKey, targetKey: p.key }, (res) => {
          if (!res?.ok) toast(res?.error || "Vote failed");
          else toast(`Voted: ${p.name}`);
        });
      };

      $("voteTargets").appendChild(btn);
    }

    $("btn-skip").disabled = iAmOut;
  } else {
    $("votePanel").classList.add("hidden");
  }
}

socket.on("room:update", (state) => {
  if (!state?.roomCode) return;
  if (currentRoom && state.roomCode !== currentRoom) return;
  currentRoom = state.roomCode;
  show("room");
  render(state);
});

// Among Us style role reveal on every role packet
socket.on("game:role", ({ roomCode, role, word, round }) => {
  if (!currentRoom) return;
  if (roomCode && roomCode !== currentRoom) return;
  if (lastState && lastState.phase !== "role") return;

  openReveal({ role, word, round });
});

socket.on("game:results", ({ eliminated, tieOrNoElim, win }) => {
  if (eliminated) {
    toast(`${eliminated.name} was eliminated (${eliminated.wasImposter ? "IMPOSTER" : "CREW"}).`);
  } else if (tieOrNoElim) {
    toast("Tie / no elimination — next round.");
  }
  if (win?.winner) toast(`WINNER: ${win.winner}`);
});

socket.on("vote:status", ({ votedCount, total }) => {
  if (!lastState || lastState.phase !== "vote") return;
  $("voteStatus").textContent = `${votedCount}/${total} voted`;
});

// Autofill room code from link
(function bootstrapRoomFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) $("code").value = code.toUpperCase().slice(0, 4);
})();
