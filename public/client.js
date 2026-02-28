// public/client.js
console.log("CLIENT VERSION: FULL-FLOW-2026-02-27");

const socket = io();
const $ = (id) => document.getElementById(id);

// safe setter
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
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

// role reveal ONCE per game (client-side; server also enforces)
let requestedRoleThisGame = false;

// game over UI state
let gameOver = false;

// Connection badge
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
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ===== ROLE REVEAL =====
function closeReveal() {
  const overlay = $("reveal");
  if (overlay) overlay.classList.add("hidden");
}

function openReveal(rolePayload) {
  lastRolePayload = rolePayload;

  $("reveal")?.classList.remove("hidden");
  $("revealTap")?.classList.remove("hidden");
  $("revealInfo")?.classList.add("hidden");

  if ($("revealRole")) $("revealRole").textContent = rolePayload.role;

  if (rolePayload.word) {
    $("revealWordWrap")?.classList.remove("hidden");
    if ($("revealWord")) $("revealWord").textContent = rolePayload.word;
  } else {
    $("revealWordWrap")?.classList.add("hidden");
    if ($("revealWord")) $("revealWord").textContent = "";
  }

  $("revealRole")?.classList.remove("imposter");
}

function wireRevealHandlers() {
  const btn = $("btn-closeReveal");
  if (btn) btn.addEventListener("click", closeReveal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeReveal();
  });

  const reveal = $("reveal");
  if (reveal) {
    reveal.addEventListener("click", (e) => {
      if (e.target === reveal) closeReveal();
    });
  }

  const tap = $("revealTap");
  if (tap) {
    tap.onclick = () => {
      $("revealTap")?.classList.add("hidden");
      $("revealInfo")?.classList.remove("hidden");

      const r = lastRolePayload?.role;
      if (r === "IMPOSTER") $("revealRole")?.classList.add("imposter");
      else $("revealRole")?.classList.remove("imposter");
    };
  }
}

// ===== ENDGAME EFFECTS =====
let confettiRunning = false;
function stopConfetti() {
  confettiRunning = false;
  const c = $("confettiCanvas");
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, c.width, c.height);
}

function startConfetti(durationMs = 4500) {
  const canvas = $("confettiCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const resize = () => {
    canvas.width = Math.floor(window.innerWidth);
    canvas.height = Math.floor(window.innerHeight);
  };
  resize();
  window.addEventListener("resize", resize);

  const pieces = [];
  const count = 170;

  function rand(min, max) { return Math.random() * (max - min) + min; }

  for (let i = 0; i < count; i++) {
    pieces.push({
      x: rand(0, canvas.width),
      y: rand(-canvas.height, 0),
      vx: rand(-1.2, 1.2),
      vy: rand(2.2, 6.0),
      size: rand(4, 10),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.2, 0.2),
      hue: rand(0, 360),
      alpha: rand(0.7, 1.0),
    });
  }

  const start = performance.now();
  confettiRunning = true;

  function tick(now) {
    if (!confettiRunning) return;
    const elapsed = now - start;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;

      if (p.y > canvas.height + 20) {
        p.y = rand(-200, -20);
        p.x = rand(0, canvas.width);
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `hsla(${p.hue}, 90%, 60%, ${p.alpha})`;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    }

    if (elapsed < durationMs) {
      requestAnimationFrame(tick);
    } else {
      stopConfetti();
      window.removeEventListener("resize", resize);
    }
  }

  requestAnimationFrame(tick);
}

function showEndgame({ winner, imposters }) {
  gameOver = true;

  const overlay = $("endgame");
  if (!overlay) return;

  $("endTitle").textContent = winner === "CREW" ? "CREW WIN!" : "IMPOSTERS WIN!";
  $("endImposters").textContent = (imposters && imposters.length)
    ? imposters.join(", ")
    : "—";

  overlay.classList.remove("hidden");

  // effects
  document.body.classList.remove("alarm");
  document.body.classList.remove("shake");
  stopConfetti();

  if (winner === "CREW") {
    startConfetti(5200);
  } else {
    // alarm + a quick shake
    document.body.classList.add("alarm");
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 450);
  }
}

function hideEndgame() {
  $("endgame")?.classList.add("hidden");
  stopConfetti();
  document.body.classList.remove("alarm");
}

// ===== UI WIRING =====
window.addEventListener("DOMContentLoaded", () => {
  wireRevealHandlers();

  $("btn-closeEnd")?.addEventListener("click", hideEndgame);
});

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
  gameOver = false;

  $("players").innerHTML = "";
  $("order").innerHTML = "";
  $("voteTargets").innerHTML = "";
  $("votePanel").classList.add("hidden");

  closeReveal();
  hideEndgame();

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

// Host: next speaker button
$("btn-nextSpeaker").onclick = () => {
  if (!lastState || !currentRoom) return;
  socket.emit("speaker:next", { roomCode: lastState.roomCode, playerKey }, (res) => {
    if (!res?.ok) toast(res?.error || "Couldn’t advance speaker.");
  });
};

function render(state) {
  lastState = state;

  $("room-code").textContent = state.roomCode;
  $("round").textContent = String(state.round || 0);
  $("phase").textContent = phaseLabel(state.phase);

  const amHost = state.hostKey === playerKey;

  // Host controls
  $("btn-host").classList.toggle("hidden", !amHost);
  $("btn-end").classList.toggle("hidden", !(amHost && state.phase !== "lobby"));

  // Next Speaker only during discussion and only host and only if game not over
  const showNextSpeaker = amHost && state.phase === "discuss" && !gameOver;
  $("btn-nextSpeaker").classList.toggle("hidden", !showNextSpeaker);

  $("btn-end").onclick = () => {
    socket.emit("game:end", { roomCode: state.roomCode, playerKey }, (res) => {
      if (!res?.ok) toast(res?.error || "Couldn’t end.");
    });
  };

  const hostBtn = $("btn-host");
  hostBtn.onclick = null;

  // If game is over, host button becomes "Game Over"
  if (amHost && gameOver) {
    hostBtn.textContent = "Game Over";
    hostBtn.onclick = () => toast("Host: click End Game to return to lobby.");
  } else if (amHost) {
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
    if (o.key === state.currentSpeakerKey && state.phase === "discuss") badges.push("Speaking");
    if (o.eliminated) badges.push("Out");
    if (!o.connected) badges.push("Offline");
    right.textContent = badges.join(" • ");

    if (o.key === state.currentSpeakerKey && state.phase === "discuss") row.classList.add("active");
    if (o.eliminated) row.classList.add("out");

    row.appendChild(left);
    row.appendChild(right);
    $("order").appendChild(row);
  }

  // Vote panel
  if (state.phase === "vote" && !gameOver) {
    $("votePanel").classList.remove("hidden");

    const me = state.players.find(p => p.key === playerKey);
    const iAmOut = !!me?.eliminated;

    const vs = state.voteStatus || { votedCount: 0, total: 0 };
    $("voteStatus").textContent = `${vs.votedCount}/${vs.total} voted`;

    if (amHost) {
      $("btn-host").textContent = vs.votedCount === vs.total ? "Votes complete…" : "Waiting for votes…";
    }

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

// ===== SOCKET EVENTS =====
socket.on("room:update", (state) => {
  if (!state?.roomCode) return;

  // ✅ If you clicked Leave, currentRoom becomes null — ignore pushes
  if (!currentRoom) return;

  // ✅ Only accept updates for the room you’re still in
  if (state.roomCode !== currentRoom) return;

  show("room");
  render(state);

  // Role reveal ONCE per game: request role the first time we ever enter role phase.
  if (state.phase === "role" && !requestedRoleThisGame && !gameOver) {
    requestedRoleThisGame = true;
    socket.emit("role:request", { roomCode: state.roomCode, playerKey }, () => {});
  }

  // Reset flags when back to lobby
  if (state.phase === "lobby") {
    requestedRoleThisGame = false;
    gameOver = false;
    setText("room-msg", "");
    closeReveal();
    hideEndgame();
  }
});

socket.on("game:role", ({ roomCode, role, word, round }) => {
  if (!currentRoom) return;
  if (roomCode && roomCode !== currentRoom) return;

  // Only show if we’re in role phase (or don’t have state yet)
  if (lastState && lastState.phase !== "role") return;

  openReveal({ role, word, round });
});

socket.on("game:announce", ({ msg }) => {
  if (!msg) return;
  setText("room-msg", msg);
  toast(msg);
});

socket.on("vote:status", ({ votedCount, total }) => {
  if (!lastState || lastState.phase !== "vote") return;
  setText("voteStatus", `${votedCount}/${total} voted`);
});

socket.on("game:results", ({ eliminated, tieOrNoElim, win }) => {
  if (eliminated) {
    toast(`${eliminated.name} was eliminated (${eliminated.wasImposter ? "IMPOSTER" : "CREW"}).`);
  } else if (tieOrNoElim) {
    toast("Tie / no elimination — host can start next round.");
  }
  if (win?.winner) toast(`WINNER: ${win.winner}`);
});

socket.on("game:win", ({ winner, imposters }) => {
  showEndgame({ winner, imposters: imposters?.map(x => x.name) || [] });
});

// Autofill room code from link
(function bootstrapRoomFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) $("code").value = code.toUpperCase().slice(0, 4);
})();
