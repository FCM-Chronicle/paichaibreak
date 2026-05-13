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
const roomCodes = new Map(); // roomCode -> roomId 매핑

/**
 * @type {Map<string, string>} invitedSocketId -> inviterSocketId
 * 보류 중인 1v1 초대 목록을 저장합니다.
 */
const pendingInvites = new Map();
/**
 * @typedef {{ id:string, name:string, color:string, shape:string, roomId:string|null }} Player - 플레이어 정보
 * @typedef {{ id:string, code:string, name:string, hostId:string, players:string[], state:'waiting'|'playing' }} Room - 방 정보
 */

// ════════════════════════════════════════════════════════
//  유틸
// ════════════════════════════════════════════════════════

/** 고유한 4자리 숫자 방 코드를 생성합니다. */
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString(); // 1000-9999
  } while (roomCodes.has(code)); // 중복 방지
  return code;
}

/** 고유한 ID를 생성합니다. */
function uuid() { return Math.random().toString(36).slice(2, 9); }

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
    code:   r.code, // 방 코드 포함
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
    players.set(socket.id, player); // 플레이어 정보 저장 로직 추가

    socket.emit('login:ack', { ok: true, player });
    broadcastLobby(); // 새로운 플레이어가 로그인했으므로 로비 상태를 모두에게 브로드캐스트
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
    if (!p || p.roomId) {
      socket.emit('room:error', { msg: 'Already in a room or not logged in.' });
      return;
    }

    const roomId = uuid();
    const roomCode = generateRoomCode();
    const room = {
      id:      roomId,
      code:    roomCode,
      name:    String(roomName || `${p.name}'s ROOM`).slice(0, 24),
      hostId:  socket.id,
      players: [socket.id],
      state:   'waiting',
    };
    rooms.set(roomId, room);
    p.roomId = roomId;
    roomCodes.set(roomCode, roomId); // 코드-ID 매핑 저장

    socket.join(roomId);
    socket.emit('room:joined', { roomId, room: sanitizeRoom(room) });
    broadcastLobby();
    console.log(`[room:create] ${room.name} (Code: ${room.code}) by ${p.name}`);
  });

  // ── 방 참가 ─────────────────────────────────────────
  socket.on('room:join', ({ roomCode }) => {
    const p    = players.get(socket.id);
    const roomId = roomCodes.get(roomCode);
    if (!roomId) {
      socket.emit('room:error', { msg: 'Room not found with that code.' });
      return;
    }
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
    } else { /* 1명만 들어온 경우, 게임 시작 대기 */ }

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

  // 연결이 끊기는 중 (방 정보가 아직 소켓에 남아있을 때)
  socket.on('disconnecting', () => {
    // 플레이어가 방을 나가거나 연결이 끊어질 때, 관련 초대 정리
    leaveRoom(socket);
  });

  // ── 연결 끊김 ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    clearPlayerInvites(socket.id); // 연결 끊김 시 초대 정리
    players.delete(socket.id);
    broadcastLobby();
  });

  // ── 1대1 초대 ────────────────────────────────────────
  socket.on('player:invite', ({ targetId }) => {
    const inviter = players.get(socket.id);
    const invited = players.get(targetId);

    if (!inviter || !invited) {
      socket.emit('player:invite:error', { msg: 'Player not found.' });
      return;
    }
    if (inviter.id === invited.id) {
      socket.emit('player:invite:error', { msg: 'Cannot invite yourself.' });
      return;
    }
    if (inviter.roomId || invited.roomId) {
      socket.emit('player:invite:error', { msg: 'One or both players are already in a room.' });
      return;
    }
    if (pendingInvites.has(invited.id)) {
      socket.emit('player:invite:error', { msg: `${invited.name} already has a pending invitation.` });
      return;
    }

    pendingInvites.set(invited.id, inviter.id);
    io.to(invited.id).emit('player:invite:request', { inviterId: inviter.id, inviterName: inviter.name });
    socket.emit('player:invite:ack', { invitedName: invited.name });
    console.log(`[player:invite] ${inviter.name} invited ${invited.name}`);
  });

  // ── 1대1 초대 수락 ───────────────────────────────────
  socket.on('player:invite:accept', () => {
    const invitedId = socket.id;
    const inviterId = pendingInvites.get(invitedId);

    if (!inviterId) {
      socket.emit('player:invite:error', { msg: 'No pending invitation.' });
      return;
    }

    const inviter = players.get(inviterId);
    const invited = players.get(invitedId);

    if (!inviter || !invited || inviter.roomId || invited.roomId) {
      socket.emit('player:invite:error', { msg: 'Invitation invalid or players busy.' });
      pendingInvites.delete(invitedId); // 유효하지 않은 초대 정리
      return;
    }

    // 방 생성
    const roomId = uuid();
    const room = {
      id:      roomId,
      name:    `${inviter.name} vs ${invited.name}`,
      hostId:  inviter.id,
      players: [inviter.id, invited.id],
      state:   'waiting',
    };
    rooms.set(roomId, room);

    inviter.roomId = roomId;
    invited.roomId = roomId;

    io.to(inviter.id).socketsJoin(roomId);
    io.to(invited.id).socketsJoin(roomId);

    io.to(inviter.id).emit('room:joined', { roomId, room: sanitizeRoom(room) });
    io.to(invited.id).emit('room:joined', { roomId, room: sanitizeRoom(room) });

    pendingInvites.delete(invitedId);
    startRoom(room);
    broadcastLobby();
    console.log(`[player:invite:accept] ${invited.name} accepted invite from ${inviter.name}. Room ${room.name} created.`);
  });

  // ── 1대1 초대 거절 ───────────────────────────────────
  socket.on('player:invite:decline', () => {
    const invitedId = socket.id;
    const inviterId = pendingInvites.get(invitedId);

    if (!inviterId) {
      socket.emit('player:invite:error', { msg: 'No pending invitation to decline.' });
      return;
    }

    const inviter = players.get(inviterId);
    if (inviter) {
      io.to(inviter.id).emit('player:invite:declined', { invitedName: players.get(invitedId)?.name || 'Unknown Player' });
    }
    pendingInvites.delete(invitedId);
    console.log(`[player:invite:decline] ${players.get(invitedId)?.name} declined invite from ${inviter?.name}`);
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

/**
 * 특정 플레이어와 관련된 모든 보류 중인 초대를 지웁니다.
 * @param {string} socketId - 플레이어의 소켓 ID
 */
function clearPlayerInvites(socketId) {
  // 이 플레이어가 누군가를 초대한 경우
  for (const [invitedId, inviterId] of pendingInvites.entries()) {
    if (inviterId === socketId) {
      pendingInvites.delete(invitedId);
      io.to(invitedId).emit('player:invite:cancelled', { msg: 'Inviter disconnected.' });
    }
  }
  // 이 플레이어가 누군가에게 초대받은 경우
  if (pendingInvites.has(socketId)) {
    const inviterId = pendingInvites.get(socketId);
    pendingInvites.delete(socketId);
    io.to(inviterId).emit('player:invite:declined', { invitedName: players.get(socketId)?.name || 'Unknown Player', msg: 'Invited player disconnected.' });
  }
}
/** 소켓이 현재 방에서 퇴장 */
function leaveRoom(socket) {
  const p = players.get(socket.id);
  if (!p?.roomId) return;

  const room = rooms.get(p.roomId);
  if (room) {
    room.players = room.players.filter(id => id !== socket.id);
    pendingInvites.delete(socket.id); // 방을 나갈 때 보류 중인 초대도 정리

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
    roomCodes.delete(room.code); // 방 코드 매핑도 삭제
  }

  socket.leave(p.roomId);
  p.roomId = null;
  clearPlayerInvites(socket.id); // 방을 나갈 때도 초대 정리
  broadcastLobby();
}

/** 클라이언트에 보낼 Room 객체 (내부 필드 숨김) */
function sanitizeRoom(room) {
  return {
    id:     room.id,
    code:   room.code, // 방 코드 포함
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
