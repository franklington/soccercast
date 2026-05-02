'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// Rate-limit the HTML page routes to prevent DoS via repeated file-system reads
const pageRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // max 60 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/receiver', pageRateLimit, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'receiver.html'))
);
app.get('/controller', pageRateLimit, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'controller.html'))
);

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------
const FIELD_W = 800;
const FIELD_H = 500;
const PLAYER_R = 16;
const BALL_R = 12;
const PLAYER_SPEED = 4.5;
const BALL_FRICTION = 0.96;
const KICK_FORCE = 8;
const GOAL_W = 130; // height of goal opening on each end wall
const TICK_MS = 1000 / 30; // 30 fps physics loop

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let state = {
  players: {},   // socketId -> { id, name, team, x, y }
  ball: resetBallState(),
  score: { red: 0, blue: 0 },
  phase: 'waiting', // 'waiting' | 'playing' | 'goal'
};

let inputs = {}; // socketId -> { dx, dy }  (normalised –1..1)

let goalResetTimer = null;

function resetBallState() {
  return { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 };
}

function goalTop() {
  return (FIELD_H - GOAL_W) / 2;
}
function goalBottom() {
  return (FIELD_H + GOAL_W) / 2;
}

/** Place players symmetrically on their half and reset the ball. */
function resetPositions() {
  const reds = Object.values(state.players).filter(p => p.team === 'red');
  const blues = Object.values(state.players).filter(p => p.team === 'blue');

  reds.forEach((p, i) => {
    p.x = FIELD_W * 0.25;
    p.y = FIELD_H * (i + 1) / (reds.length + 1);
  });
  blues.forEach((p, i) => {
    p.x = FIELD_W * 0.75;
    p.y = FIELD_H * (i + 1) / (blues.length + 1);
  });

  state.ball = resetBallState();
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Physics tick – runs at 30 fps
// ---------------------------------------------------------------------------
function gameTick() {
  if (state.phase !== 'playing') return;

  const ball = state.ball;
  const playerList = Object.values(state.players);

  // --- Move players from joystick input ---
  for (const player of playerList) {
    const inp = inputs[player.id] || { dx: 0, dy: 0 };
    player.x = clamp(player.x + inp.dx * PLAYER_SPEED, PLAYER_R, FIELD_W - PLAYER_R);
    player.y = clamp(player.y + inp.dy * PLAYER_SPEED, PLAYER_R, FIELD_H - PLAYER_R);
  }

  // --- Player-player separation ---
  for (let i = 0; i < playerList.length; i++) {
    for (let j = i + 1; j < playerList.length; j++) {
      const a = playerList[i];
      const b = playerList[j];
      const d = distance(a, b);
      if (d < PLAYER_R * 2 && d > 0) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const overlap = (PLAYER_R * 2 - d) / 2;
        a.x -= Math.cos(angle) * overlap;
        a.y -= Math.sin(angle) * overlap;
        b.x += Math.cos(angle) * overlap;
        b.y += Math.sin(angle) * overlap;
        // Re-clamp after separation
        a.x = clamp(a.x, PLAYER_R, FIELD_W - PLAYER_R);
        a.y = clamp(a.y, PLAYER_R, FIELD_H - PLAYER_R);
        b.x = clamp(b.x, PLAYER_R, FIELD_W - PLAYER_R);
        b.y = clamp(b.y, PLAYER_R, FIELD_H - PLAYER_R);
      }
    }
  }

  // --- Player-ball collision (kick/push) ---
  for (const player of playerList) {
    const d = distance(player, ball);
    const minDist = PLAYER_R + BALL_R;
    if (d < minDist && d > 0) {
      const angle = Math.atan2(ball.y - player.y, ball.x - player.x);
      const inp = inputs[player.id] || { dx: 0, dy: 0 };
      // Transfer kick force to ball
      ball.vx = Math.cos(angle) * KICK_FORCE + inp.dx * 3;
      ball.vy = Math.sin(angle) * KICK_FORCE + inp.dy * 3;
      // Separate ball from player
      const overlap = minDist - d;
      ball.x += Math.cos(angle) * overlap;
      ball.y += Math.sin(angle) * overlap;
    }
  }

  // --- Move ball ---
  ball.x += ball.vx;
  ball.y += ball.vy;
  ball.vx *= BALL_FRICTION;
  ball.vy *= BALL_FRICTION;

  // --- Ball wall bounces (top / bottom) ---
  if (ball.y - BALL_R < 0) {
    ball.y = BALL_R;
    ball.vy *= -0.7;
  }
  if (ball.y + BALL_R > FIELD_H) {
    ball.y = FIELD_H - BALL_R;
    ball.vy *= -0.7;
  }

  // --- Ball left / right wall bounce (outside goal opening) ---
  const gTop = goalTop();
  const gBottom = goalBottom();

  if (ball.x - BALL_R < 0 && (ball.y < gTop || ball.y > gBottom)) {
    ball.x = BALL_R;
    ball.vx *= -0.7;
  }
  if (ball.x + BALL_R > FIELD_W && (ball.y < gTop || ball.y > gBottom)) {
    ball.x = FIELD_W - BALL_R;
    ball.vx *= -0.7;
  }

  // --- Goal detection ---
  // Left goal → blue scores   Right goal → red scores
  let scorer = null;
  if (ball.x - BALL_R <= 0 && ball.y >= gTop && ball.y <= gBottom) {
    scorer = 'blue';
  } else if (ball.x + BALL_R >= FIELD_W && ball.y >= gTop && ball.y <= gBottom) {
    scorer = 'red';
  }

  if (scorer) {
    state.score[scorer]++;
    state.phase = 'goal';
    io.emit('goal', { scorer, score: { ...state.score } });
    goalResetTimer = setTimeout(() => {
      goalResetTimer = null;
      // Only resume if a goal phase is still active (players haven't all left)
      if (state.phase !== 'goal') return;
      resetPositions();
      state.phase = 'playing';
    }, 3000);
  }

  // --- Broadcast state ---
  io.emit('gameState', buildBroadcast());
}

function buildBroadcast() {
  return {
    players: Object.values(state.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: Math.round(p.x),
      y: Math.round(p.y),
    })),
    ball: {
      x: Math.round(state.ball.x),
      y: Math.round(state.ball.y),
    },
    score: { ...state.score },
    phase: state.phase,
  };
}

// Start physics loop
setInterval(gameTick, TICK_MS);

// Broadcast phase changes when not in 'playing' (e.g. waiting)
setInterval(() => {
  if (state.phase !== 'playing') {
    io.emit('gameState', buildBroadcast());
  }
}, 500);

// ---------------------------------------------------------------------------
// Socket.io events
// ---------------------------------------------------------------------------
io.on('connection', socket => {
  console.log(`[connect]  ${socket.id}`);

  socket.on('join', ({ name, team }) => {
    const safeName = String(name || 'Player').slice(0, 14);
    const safeTeam = team === 'blue' ? 'blue' : 'red';

    // Default spawn positions (overridden by resetPositions if game is live)
    const startX = safeTeam === 'red' ? FIELD_W * 0.25 : FIELD_W * 0.75;
    const startY = FIELD_H / 2 + (Math.random() - 0.5) * 200;

    state.players[socket.id] = {
      id: socket.id,
      name: safeName,
      team: safeTeam,
      x: startX,
      y: clamp(startY, PLAYER_R, FIELD_H - PLAYER_R),
    };
    inputs[socket.id] = { dx: 0, dy: 0 };

    if (state.phase === 'waiting' && Object.keys(state.players).length >= 1) {
      state.phase = 'playing';
    }

    socket.emit('joined', { id: socket.id, name: safeName, team: safeTeam });
    io.emit('playerList', buildPlayerList());
    console.log(`[join]     ${safeName} (${safeTeam})`);
  });

  socket.on('input', ({ dx, dy }) => {
    if (!inputs[socket.id]) return;
    // Clamp to –1..1
    inputs[socket.id] = {
      dx: Math.max(-1, Math.min(1, Number(dx) || 0)),
      dy: Math.max(-1, Math.min(1, Number(dy) || 0)),
    };
  });

  socket.on('disconnect', () => {
    const player = state.players[socket.id];
    if (player) {
      console.log(`[leave]    ${player.name}`);
    }
    delete state.players[socket.id];
    delete inputs[socket.id];

    if (Object.keys(state.players).length === 0) {
      // Cancel any pending goal-reset so it doesn't restart a now-empty game
      if (goalResetTimer !== null) {
        clearTimeout(goalResetTimer);
        goalResetTimer = null;
      }
      state.phase = 'waiting';
      state.ball = resetBallState();
      state.score = { red: 0, blue: 0 };
    }

    io.emit('playerList', buildPlayerList());
    console.log(`[disconnect] ${socket.id}`);
  });
});

function buildPlayerList() {
  return Object.values(state.players).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
  }));
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`⚽  SoccerCast running → http://localhost:${PORT}`);
  console.log(`   TV display  : http://localhost:${PORT}/receiver`);
  console.log(`   Controller  : http://localhost:${PORT}/controller`);
});
