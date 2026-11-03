const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 词库 ----------
const DEFAULT_IDIOMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'idioms.json'), 'utf8'));
const DEFAULT_EMOTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'emotions.json'), 'utf8'));
const DEFAULT_TECHNIQUES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'techniques.json'), 'utf8'));

// ---------- 工具 ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, min, max, dft) => {
  const n = Number(v);
  if (Number.isNaN(n)) return dft;
  return Math.max(min, Math.min(max, Math.round(n)));
};
const charLen = (s) => [...String(s)].length; // 含标点，按字符（码点）计数
const tailChars = (s, n) => [...String(s)].slice(-n).join('');

function genCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => rnd([...CODE_CHARS])).join('');
  } while (rooms.has(c));
  return c;
}
function shuffle(arr) {
  const x = [...arr];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
function newPid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function cleanName(name) {
  return (String(name || '').trim().replace(/\s+/g, ' ').slice(0, 12)) || '玩家';
}

// ---------- 房间 ----------
function defaultSettings() {
  return {
    mode: 'classic',        // classic | challenge | custom
    theme: '',
    maxPlayers: 8,          // 2-20
    maxChars: 30,           // 20-200 每回合最大字数（含标点）
    hintChars: 10,          // 提示展示字数（含标点）
    rounds: 10,             // 1-20 结束轮次
    timed: false,
    limitSeconds: 60,       // 10-600
    refreshCount: 1,        // 0-5 卡牌刷新次数
    useDefaultBank: true,
    customBank: '',
    useDefaultEmotions: true,
    customEmotions: '',
    useDefaultTechniques: true,
    customTechniques: ''
  };
}

function createRoom() {
  const room = {
    code: genCode(),
    hostId: null,
    phase: 'lobby',          // lobby | playing | ended
    settings: defaultSettings(),
    players: new Map(),      // pid -> {pid,name,socketId,connected}
    order: [],               // 座次（pid 顺序）
    round: 1,
    turnIdx: 0,
    hint: null,              // 当前玩家可见的上文结尾
    card: null,              // 当前限制卡
    refreshLeft: 0,
    deadline: null,          // 时间戳 ms 或 null
    segments: [],            // {pid,name,text,card}
    vote: null,              // {proposer,votes:{pid:bool},deadline,timer}
    pendingEnd: false,
    usedKeywords: new Set(),
    turnTimer: null,
    voteTimer: null
  };
  rooms.set(room.code, room);
  return room;
}

function parseCustomBank(raw) {
  return String(raw || '').split(/[\n,，、;；\s]+/).map(t => t.trim()).filter(Boolean);
}
function parseCustomTechniques(raw) {
  return String(raw || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.+?)[：:]\s*(.*)$/);
    if (m) return { name: m[1].trim(), desc: m[2].trim() || '自由发挥。' };
    return { name: line, desc: '自由发挥。' };
  });
}

function getBank(room) {
  const s = room.settings;
  if (s.mode === 'custom' && !s.useDefaultBank) {
    const arr = parseCustomBank(s.customBank);
    if (arr.length) return arr;
  }
  return DEFAULT_IDIOMS;
}
function getEmotions(room) {
  const s = room.settings;
  if (s.mode === 'custom' && !s.useDefaultEmotions) {
    const arr = parseCustomBank(s.customEmotions);
    if (arr.length) return arr;
  }
  return DEFAULT_EMOTIONS;
}
function getTechniques(room) {
  const s = room.settings;
  if (s.mode === 'custom' && !s.useDefaultTechniques) {
    const arr = parseCustomTechniques(s.customTechniques);
    if (arr.length) return arr;
  }
  return DEFAULT_TECHNIQUES;
}

function genCard(room) {
  const type = rnd(['keyword', 'emotion', 'technique']);
  if (type === 'keyword') {
    let pool = getBank(room).filter(w => !room.usedKeywords.has(w));
    if (!pool.length) pool = getBank(room);
    const word = rnd(pool);
    room.usedKeywords.add(word);
    return { type: 'keyword', word };
  }
  if (type === 'emotion') {
    return { type: 'emotion', emotion: rnd(getEmotions(room)) };
  }
  const t = rnd(getTechniques(room));
  return { type: 'technique', name: t.name, desc: t.desc };
}

function cardLabel(card) {
  if (!card) return null;
  if (card.type === 'keyword') return { type: '关键词', content: card.word };
  if (card.type === 'emotion') return { type: '情绪', content: card.emotion };
  return { type: '文学手法', content: card.name, desc: card.desc };
}

// ---------- 状态广播（按玩家个性化） ----------
function connectedList(room) {
  return [...room.players.values()].filter(p => p.connected);
}
function seatList(room) {
  return room.order.map(pid => {
    const p = room.players.get(pid);
    return { pid, name: p ? p.name : '???', connected: p ? p.connected : false, host: pid === room.hostId };
  });
}
function publicState(room, pid) {
  const state = {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    me: pid,
    isHost: pid === room.hostId,
    players: [...room.players.values()].map(p => ({
      pid: p.pid, name: p.name, connected: p.connected, host: p.pid === room.hostId
    }))
  };
  if (room.phase === 'playing') {
    const cur = room.order[room.turnIdx];
    state.seats = seatList(room);
    state.round = room.round;
    state.totalRounds = room.settings.rounds;
    state.currentPid = cur;
    const curP = room.players.get(cur);
    state.currentName = curP ? curP.name : '???';
    state.isMyTurn = cur === pid;
    state.deadline = room.deadline;
    state.pendingEnd = room.pendingEnd;
    if (cur === pid) {
      state.hint = room.hint;
      state.card = cardLabel(room.card);
      state.refreshLeft = room.refreshLeft;
    }
    if (room.vote) {
      state.vote = {
        proposerName: (room.players.get(room.vote.proposer) || {}).name || '',
        deadline: room.vote.deadline,
        myVote: (pid in room.vote.votes) ? room.vote.votes[pid] : null
      };
    }
  }
  if (room.phase === 'ended') {
    state.seats = seatList(room);
    state.segments = room.segments.map(s => ({ name: s.name, text: s.text, card: cardLabel(s.card) }));
  }
  return state;
}
function broadcast(room) {
  for (const p of room.players.values()) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('state', publicState(room, p.pid));
  }
}
function sendErr(sock, msg) {
  sock.emit('error-msg', { msg });
}

// ---------- 回合流程 ----------
function clearTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
}

function startGame(room) {
  clearTimers(room);
  room.phase = 'playing';
  room.order = shuffle([...room.players.keys()]);
  room.round = 1;
  room.turnIdx = 0;
  room.segments = [];
  room.vote = null;
  room.pendingEnd = false;
  room.usedKeywords = new Set();
  beginTurn(room);
}

function beginTurn(room) {
  const s = room.settings;
  const hasCard = s.mode !== 'classic';
  room.card = hasCard ? genCard(room) : null;
  room.refreshLeft = hasCard ? s.refreshCount : 0;
  const prev = room.segments[room.segments.length - 1];
  room.hint = prev ? tailChars(prev.text, s.hintChars) : null;
  room.deadline = s.timed ? Date.now() + s.limitSeconds * 1000 : null;
  broadcast(room);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (s.timed) {
    // 服务端兜底：超时 3 秒后仍未提交则按空内容提交
    room.turnTimer = setTimeout(() => {
      const cur = room.order[room.turnIdx];
      if (cur) doSubmit(room, cur, '');
    }, s.limitSeconds * 1000 + 3000);
  }
}

function doSubmit(room, pid, text) {
  if (room.phase !== 'playing') return;
  const cur = room.order[room.turnIdx];
  if (cur !== pid) return;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  const p = room.players.get(pid);
  let t = String(text || '').trim().replace(/\s+/g, ' ');
  if (charLen(t) > room.settings.maxChars) t = [...t].slice(0, room.settings.maxChars).join('');
  room.segments.push({ pid, name: p ? p.name : '???', text: t, card: room.card });

  if (room.vote && room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
  room.vote = null;

  const finished = room.segments.length >= room.order.length * room.settings.rounds;
  if (room.pendingEnd || finished) {
    endGame(room);
    return;
  }
  room.turnIdx++;
  if (room.turnIdx >= room.order.length) {
    room.turnIdx = 0;
    room.round++;
  }
  beginTurn(room);
}

function endGame(room) {
  clearTimers(room);
  room.phase = 'ended';
  room.vote = null;
  room.pendingEnd = false;
  broadcast(room);
}

// ---------- 投票结束 ----------
function connectedCount(room) {
  return connectedList(room).length;
}
function finalizeVote(room) {
  if (!room.vote) return;
  if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
  const total = connectedCount(room);
  const yes = Object.values(room.vote.votes).filter(Boolean).length;
  const passed = yes * 2 > total;
  room.vote = null;
  if (passed) {
    room.pendingEnd = true;
  }
  broadcast(room);
}
function proposeEnd(room, pid) {
  if (room.phase !== 'playing' || room.vote || room.pendingEnd) return false;
  const votes = {};
  votes[pid] = true;
  room.vote = { proposer: pid, votes, deadline: Date.now() + 20000 };
  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.voteTimer = setTimeout(() => finalizeVote(room), 20000);
  broadcast(room);
  return true;
}
function castVote(room, pid, accept) {
  if (!room.vote) return;
  if (pid in room.vote.votes) return;
  room.vote.votes[pid] = !!accept;
  const total = connectedCount(room);
  const voted = Object.keys(room.vote.votes).filter(k => {
    const p = room.players.get(k);
    return p && p.connected;
  }).length;
  const yes = Object.values(room.vote.votes).filter(Boolean).length;
  if (yes * 2 > total || voted >= total) finalizeVote(room);
}

// ---------- 移除玩家（退出/踢人） ----------
function removePlayer(room, pid) {
  const p = room.players.get(pid);
  if (!p) return;
  room.players.delete(pid);
  const sock = io.sockets.sockets.get(p.socketId);
  if (sock) { sock.leave(room.code); sock.data = {}; }

  if (room.phase === 'playing') {
    const idx = room.order.indexOf(pid);
    if (idx === -1) return;
    const wasCurrent = idx === room.turnIdx;
    room.order.splice(idx, 1);
    if (room.order.length < 2) {
      endGame(room);
      return;
    }
    if (wasCurrent) {
      room.turnIdx = room.turnIdx % room.order.length;
      beginTurn(room);
    } else {
      if (idx < room.turnIdx) room.turnIdx--;
      broadcast(room);
    }
  } else {
    if (pid === room.hostId) {
      // 房主离开：转让房主或解散
      const next = [...room.players.keys()][0];
      if (next) {
        room.hostId = next;
        broadcast(room);
      } else {
        clearTimers(room);
        rooms.delete(room.code);
      }
    } else {
      broadcast(room);
    }
    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(room.code);
    }
  }
}

// ---------- 连接处理 ----------
io.on('connection', (sock) => {
  sock.data = {};

  sock.on('create', ({ name } = {}) => {
    const room = createRoom();
    const pid = newPid();
    room.hostId = pid;
    room.players.set(pid, { pid, name: cleanName(name), socketId: sock.id, connected: true });
    sock.join(room.code);
    sock.data = { code: room.code, pid };
    sock.emit('joined', { code: room.code, pid });
    broadcast(room);
  });

  sock.on('join', ({ code, name } = {}) => {
    const c = String(code || '').trim().toUpperCase();
    const room = rooms.get(c);
    if (!room) return sendErr(sock, '房间不存在，请检查房间码');
    if (room.phase !== 'lobby') return sendErr(sock, '该房间游戏已开始，无法加入');
    if (room.players.size >= room.settings.maxPlayers) return sendErr(sock, '房间已满');
    const pid = newPid();
    room.players.set(pid, { pid, name: cleanName(name), socketId: sock.id, connected: true });
    sock.join(c);
    sock.data = { code: c, pid };
    sock.emit('joined', { code: c, pid });
    broadcast(room);
  });

  sock.on('rejoin', ({ code, pid } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || !pid || !room.players.has(pid)) {
      return sock.emit('rejoin-failed', {});
    }
    const p = room.players.get(pid);
    p.socketId = sock.id;
    p.connected = true;
    sock.join(room.code);
    sock.data = { code: room.code, pid };
    sock.emit('joined', { code: room.code, pid });
    broadcast(room);
  });

  sock.on('update-settings', ({ settings } = {}) => {
    const room = rooms.get(sock.data.code);
    if (!room || room.hostId !== sock.data.pid || room.phase !== 'lobby') return;
    const s = settings || {};
    const d = room.settings;
    room.settings = {
      mode: ['classic', 'challenge', 'custom'].includes(s.mode) ? s.mode : d.mode,
      theme: String(s.theme ?? d.theme).slice(0, 50),
      maxPlayers: clamp(s.maxPlayers, 2, 20, d.maxPlayers),
      maxChars: clamp(s.maxChars, 20, 200, d.maxChars),
      hintChars: clamp(s.hintChars, 1, 50, d.hintChars),
      rounds: clamp(s.rounds, 1, 20, d.rounds),
      timed: !!s.timed,
      limitSeconds: clamp(s.limitSeconds, 10, 600, d.limitSeconds),
      refreshCount: clamp(s.refreshCount, 0, 5, d.refreshCount),
      useDefaultBank: s.useDefaultBank !== false,
      customBank: String(s.customBank ?? d.customBank).slice(0, 20000),
      useDefaultEmotions: s.useDefaultEmotions !== false,
      customEmotions: String(s.customEmotions ?? d.customEmotions).slice(0, 5000),
      useDefaultTechniques: s.useDefaultTechniques !== false,
      customTechniques: String(s.customTechniques ?? d.customTechniques).slice(0, 20000)
    };
    if (room.settings.hintChars > room.settings.maxChars) {
      room.settings.hintChars = room.settings.maxChars;
    }
    broadcast(room);
  });

  sock.on('start-game', () => {
    const room = rooms.get(sock.data.code);
    if (!room || room.hostId !== sock.data.pid || room.phase !== 'lobby') return;
    if (room.players.size < 2) return sendErr(sock, '至少需要 2 名玩家才能开始');
    startGame(room);
  });

  sock.on('submit-text', ({ text } = {}) => {
    const room = rooms.get(sock.data.code);
    if (!room || room.phase !== 'playing') return;
    doSubmit(room, sock.data.pid, text);
  });

  sock.on('refresh-card', () => {
    const room = rooms.get(sock.data.code);
    if (!room || room.phase !== 'playing') return;
    const cur = room.order[room.turnIdx];
    if (cur !== sock.data.pid || room.refreshLeft <= 0 || !room.card) return;
    room.card = genCard(room);
    room.refreshLeft--;
    broadcast(room);
  });

  sock.on('propose-end', () => {
    const room = rooms.get(sock.data.code);
    if (!room) return;
    if (!proposeEnd(room, sock.data.pid)) sendErr(sock, '当前无法发起结束投票');
  });

  sock.on('vote', ({ accept } = {}) => {
    const room = rooms.get(sock.data.code);
    if (!room || !room.vote) return;
    castVote(room, sock.data.pid, accept);
  });

  sock.on('kick', ({ pid } = {}) => {
    const room = rooms.get(sock.data.code);
    if (!room || room.hostId !== sock.data.pid) return;
    if (pid === room.hostId) return;
    removePlayer(room, pid);
  });

  sock.on('play-again', () => {
    const room = rooms.get(sock.data.code);
    if (!room || room.hostId !== sock.data.pid || room.phase !== 'ended') return;
    clearTimers(room);
    room.phase = 'lobby';
    room.order = [];
    room.round = 1;
    room.turnIdx = 0;
    room.hint = null;
    room.card = null;
    room.refreshLeft = 0;
    room.deadline = null;
    room.segments = [];
    room.vote = null;
    room.pendingEnd = false;
    room.usedKeywords = new Set();
    broadcast(room);
  });

  sock.on('leave', () => {
    const room = rooms.get(sock.data.code);
    if (!room) return;
    removePlayer(room, sock.data.pid);
  });

  sock.on('disconnect', () => {
    const { code, pid } = sock.data || {};
    if (!code || !pid) return;
    const room = rooms.get(code);
    if (!room || !room.players.has(pid)) return;
    const p = room.players.get(pid);
    if (p.socketId !== sock.id) return;
    p.connected = false;
    broadcast(room);
  });
});

// 闲置房间清理：全员离线超过 30 分钟则删除
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const allOffline = room.players.size === 0 || [...room.players.values()].every(p => !p.connected);
    if (allOffline) {
      if (!room.offlineSince) room.offlineSince = now;
      if (now - room.offlineSince > 30 * 60 * 1000) {
        clearTimers(room);
        rooms.delete(code);
      }
    } else {
      room.offlineSince = null;
    }
  }
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ========================================');
  console.log('   故事接龙服务器已启动');
  console.log(`   本机访问:   http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<你的局域网IP>:${PORT}`);
  console.log('  ========================================');
  console.log('');
});
