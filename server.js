/**
 * NEON CLASH — Game Server
 * Socket.io 기반 1v1 PVP 슈팅 게임 서버
 *
 * 실행: node server.js  (또는 npm run dev)
 * 접속: http://localhost:3000
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ── 정적 파일 서빙 (pvp-shooting-game.html을 같은 폴더에 두면 됨) ──
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pvp-shooting-game.html'));
});

// ════════════════════════════════════════════════════════
//  서버 상태
// ════════════════════════════════════════════════════════

/** @type {Map<string, Player>} socketId → Player */
const players = new Map();

/** @type {Map<string, Room>}   roomId   → Room   */
const rooms   = new Map();

/**
 * @typedef {{ id:string, name:string, color:string, shape:string, roomId:string|null }} Player
 * @typedef {{ id:string, name:string, hostId:string, players:string[], state:'waiting'|'playing' }} Room
 */

// ════════════════════════════════════════════════════════
//  유틸
// ════════════════════════════════════════════════════════

function uuid() {
  return Math.random().toString(36).slice(2, 9);
}

/** 모든 클라이언트에게 현재 로비 상태를 브로드캐스트 */
function broadcastLobby() {
  const playerList = [...players.values()].map(p => ({
    id:    p.id,
    name:  p.name,
    color: p.color,
    shape: p.shape,
    status: p.roomId ? 'in-game' : 'idle',
  }));

  const roomList = [...rooms.values()].map(r => ({
    id:     r.id,
    name:   r.name,
    host:   players.get(r.hostId)?.name ?? '?',
    count:  r.players.length,
    max:    2,
    state:  r.state,
  }));

  io.emit('lobby:update', { playerList, roomList });
}

// ════════════════════════════════════════════════════════
//  Socket.io 이벤트
// ════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── 로그인 ──────────────────────────────────────────
  socket.on('login', ({ name, color, shape }) => {
    if (players.has(socket.id)) return;   // 중복 방지

    const player = {
      id:     socket.id,
      name:   String(name).slice(0, 16).toUpperCase(),
      color:  color || '#00f5ff',
      shape:  shape === 'circle' ? 'circle' : 'rect',
      roomId: null,
    };
    players.set(socket.id, player);

    socket.emit('login:ack', { ok: true, player });
    broadcastLobby();
    console.log(`[login] ${player.name}`);
  });

  // ── 커스터마이즈 변경 ───────────────────────────────
  socket.on('customize', ({ color, shape }) => {
    const p = players.get(socket.id);
    if (!p || p.roomId) return;   // 게임 중엔 변경 불가
    if (color) p.color = color;
    if (shape) p.shape = shape === 'circle' ? 'circle' : 'rect';
    broadcastLobby();
  });

  // ── 방 만들기 ───────────────────────────────────────
  socket.on('room:create', ({ roomName }) => {
    const p = players.get(socket.id);
    if (!p || p.roomId) return;

    const roomId = uuid();
    const room = {
      id:      roomId,
      name:    String(roomName || `${p.name}'s ROOM`).slice(0, 24),
      hostId:  socket.id,
      players: [socket.id],
      state:   'waiting',
    };
    rooms.set(roomId, room);
    p.roomId = roomId;

    socket.join(roomId);
    socket.emit('room:joined', { roomId, room: sanitizeRoom(room) });
    broadcastLobby();
    console.log(`[room:create] ${room.name} by ${p.name}`);
  });

  // ── 방 참가 ─────────────────────────────────────────
  socket.on('room:join', ({ roomId }) => {
    const p    = players.get(socket.id);
    const room = rooms.get(roomId);
    if (!p || !room) return;
    if (p.roomId) return;                         // 이미 방에 있음
    if (room.players.length >= 2) {
      socket.emit('room:error', { msg: 'ROOM FULL' });
      return;
    }
    if (room.state !== 'waiting') {
      socket.emit('room:error', { msg: 'GAME IN PROGRESS' });
      return;
    }

    room.players.push(socket.id);
    p.roomId = roomId;
    socket.join(roomId);
    socket.emit('room:joined', { roomId, room: sanitizeRoom(room) });

    // 2명이 모이면 자동 게임 시작
    if (room.players.length === 2) {
      startRoom(room);
    }

    broadcastLobby();
    console.log(`[room:join] ${p.name} → ${room.name}`);
  });

  // ── 방 나가기 ───────────────────────────────────────
  socket.on('room:leave', () => leaveRoom(socket));

  // ════════════════════════════════════════════════════
  //  게임 중 이벤트 (서버는 relay + 검증만 담당)
  // ════════════════════════════════════════════════════

  /** 이동 상태 (키/터치 입력) 전송 */
  socket.on('game:input', (inputState) => {
    const p = players.get(socket.id);
    if (!p?.roomId) return;
    // 상대방에게만 relay
    socket.to(p.roomId).emit('game:input', {
      id: socket.id,
      ...inputState,          // { up, down, left, right }
    });
  });

  /** 총알 발사 */
  socket.on('game:shoot', ({ dx, dy, isUlt }) => {
    const p = players.get(socket.id);
    if (!p?.roomId) return;
    socket.to(p.roomId).emit('game:shoot', {
      id: socket.id,
      dx, dy,
      isUlt: !!isUlt,
    });
  });

  /** 대시 */
  socket.on('game:dash', () => {
    const p = players.get(socket.id);
    if (!p?.roomId) return;
    socket.to(p.roomId).emit('game:dash', { id: socket.id });
  });

  /** 위치 동기화 (100ms마다 클라이언트가 전송) */
  socket.on('game:sync', ({ x, y, hp, ultGauge }) => {
    const p = players.get(socket.id);
    if (!p?.roomId) return;
    socket.to(p.roomId).emit('game:sync', {
      id: socket.id,
      x, y, hp, ultGauge,
    });
  });

  /** 게임 종료 결과 */
  socket.on('game:over', ({ winnerId }) => {
    const p    = players.get(socket.id);
    const room = p?.roomId ? rooms.get(p.roomId) : null;
    if (!room || room.state !== 'playing') return;

    room.state = 'waiting';   // 재매치 대비 리셋
    io.to(room.id).emit('game:result', {
      winnerId,
      winnerName: players.get(winnerId)?.name ?? 'UNKNOWN',
    });
    console.log(`[game:over] room=${room.id} winner=${winnerId}`);
    broadcastLobby();
  });

  // ── 연결 끊김 ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    leaveRoom(socket);
    players.delete(socket.id);
    broadcastLobby();
  });
});

// ════════════════════════════════════════════════════════
//  헬퍼 함수
// ════════════════════════════════════════════════════════

/** 방 시작 (2명 모였을 때) */
function startRoom(room) {
  room.state = 'playing';

  const [id1, id2] = room.players;
  const p1 = players.get(id1);
  const p2 = players.get(id2);

  // 각 플레이어에게 자신의 역할(left/right)과 상대 정보 전송
  io.to(id1).emit('game:start', {
    role:     'left',
    self:     sanitizePlayer(p1),
    opponent: sanitizePlayer(p2),
  });
  io.to(id2).emit('game:start', {
    role:     'right',
    self:     sanitizePlayer(p2),
    opponent: sanitizePlayer(p1),
  });

  console.log(`[game:start] ${room.name} — ${p1.name} vs ${p2.name}`);
}

/** 소켓이 현재 방에서 퇴장 */
function leaveRoom(socket) {
  const p = players.get(socket.id);
  if (!p?.roomId) return;

  const room = rooms.get(p.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== socket.id);

    if (room.players.length === 0) {
      // 빈 방 삭제
      rooms.delete(room.id);
    } else {
      // 남은 플레이어에게 상대 퇴장 알림
      room.state  = 'waiting';
      room.hostId = room.players[0];
      io.to(room.id).emit('room:opponentLeft', {
        msg: `${p.name} has left the room.`,
      });
    }
  }

  socket.leave(p.roomId);
  p.roomId = null;
  broadcastLobby();
}

/** 클라이언트에 보낼 Room 객체 (내부 필드 숨김) */
function sanitizeRoom(room) {
  return {
    id:     room.id,
    name:   room.name,
    host:   players.get(room.hostId)?.name ?? '?',
    count:  room.players.length,
    max:    2,
    state:  room.state,
  };
}

/** 클라이언트에 보낼 Player 객체 */
function sanitizePlayer(p) {
  return { id: p.id, name: p.name, color: p.color, shape: p.shape };
}

// ════════════════════════════════════════════════════════
//  서버 시작
// ════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║      NEON CLASH  —  SERVER       ║
  ║  http://localhost:${PORT}           ║
  ╚══════════════════════════════════╝
  `);
});
