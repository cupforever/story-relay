/* ============ 故事接龙 · 前端逻辑 ============ */
const socket = io();
const $ = (id) => document.getElementById(id);

const MODE_HINTS = {
  classic: '经典接力：纯粹的文字传递，看故事走向何方。',
  challenge: '挑战接力：每回合抽取一张限制卡（关键词 / 情绪 / 文学手法），可刷新，以最后一次为准。',
  custom: '自定义接力：在挑战模式基础上，房主可替换关键词词库、情绪与文学手法。'
};

let state = null;          // 最近一次服务端状态
let myPid = null;
let myCode = null;
let lastTurnKey = null;    // 用于判断"新回合"清空输入
let autoSubmitted = false; // 限时自动提交防重
let timerInt = null;
let toastTimer = null;

/* ---------- 工具 ---------- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const charLen = (s) => [...s].length;
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}

/* ---------- 连接与加入 ---------- */
socket.on('connect', () => {
  const savedCode = sessionStorage.getItem('sr_code');
  const savedPid = sessionStorage.getItem('sr_pid');
  if (savedCode && savedPid) {
    socket.emit('rejoin', { code: savedCode, pid: savedPid });
  }
});
socket.on('rejoin-failed', () => {
  sessionStorage.removeItem('sr_code');
  sessionStorage.removeItem('sr_pid');
  state = null;
  showScreen('home');
});
socket.on('joined', ({ code, pid }) => {
  myCode = code;
  myPid = pid;
  sessionStorage.setItem('sr_code', code);
  sessionStorage.setItem('sr_pid', pid);
});
socket.on('error-msg', ({ msg }) => toast(msg));

socket.on('state', (s) => {
  state = s;
  if (s.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
  else if (s.phase === 'playing') { renderGame(); showScreen('game'); }
  else if (s.phase === 'ended') { renderResult(); showScreen('result'); }
});

/* ---------- 首页 ---------- */
$('btn-create').addEventListener('click', () => {
  socket.emit('create', { name: $('nickname').value });
});
$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) return toast('请输入房间码');
  socket.emit('join', { code, name: $('nickname').value });
});
$('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});

/* ---------- 大厅 ---------- */
$('lobby-leave').addEventListener('click', () => {
  socket.emit('leave');
  sessionStorage.removeItem('sr_code');
  sessionStorage.removeItem('sr_pid');
  state = null;
  showScreen('home');
});
$('copy-code').addEventListener('click', () => {
  if (!state) return;
  navigator.clipboard?.writeText(state.code).then(() => toast('房间码已复制')).catch(() => toast('复制失败，请手动复制'));
});

// 模式切换（仅房主）
document.querySelectorAll('#mode-control button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state || !state.isHost) return;
    collectAndSendSettings({ mode: btn.dataset.mode });
  });
});
$('set-timed').addEventListener('change', () => {
  $('timed-detail').classList.toggle('hidden', !$('set-timed').checked);
  hostSyncSettings();
});
['set-theme', 'set-maxplayers', 'set-maxchars', 'set-hintchars', 'set-rounds', 'set-limitseconds', 'set-refreshcount'].forEach(id => {
  $(id).addEventListener('change', hostSyncSettings);
});
['set-usebank', 'set-useemotions', 'set-techniques'].forEach(id => {
  $(id).addEventListener('change', () => {
    syncCustomTextareas();
    hostSyncSettings();
  });
});
['set-custombank', 'set-customemotions', 'set-customtechniques'].forEach(id => {
  $(id).addEventListener('change', hostSyncSettings);
});
$('btn-start').addEventListener('click', () => socket.emit('start-game'));

function syncCustomTextareas() {
  $('set-custombank').classList.toggle('hidden', $('set-usebank').checked);
  $('set-customemotions').classList.toggle('hidden', $('set-useemotions').checked);
  $('set-customtechniques').classList.toggle('hidden', $('set-techniques').checked);
}
function hostSyncSettings() {
  if (!state || !state.isHost) return;
  collectAndSendSettings({});
}
function collectAndSendSettings(extra) {
  socket.emit('update-settings', {
    settings: {
      mode: document.querySelector('#mode-control button.active')?.dataset.mode || 'classic',
      theme: $('set-theme').value,
      maxPlayers: +$('set-maxplayers').value,
      maxChars: +$('set-maxchars').value,
      hintChars: +$('set-hintchars').value,
      rounds: +$('set-rounds').value,
      timed: $('set-timed').checked,
      limitSeconds: +$('set-limitseconds').value,
      refreshCount: +$('set-refreshcount').value,
      useDefaultBank: $('set-usebank').checked,
      customBank: $('set-custombank').value,
      useDefaultEmotions: $('set-useemotions').checked,
      customEmotions: $('set-customemotions').value,
      useDefaultTechniques: $('set-techniques').checked,
      customTechniques: $('set-customtechniques').value,
      ...extra
    }
  });
}

function applySettingsToForm(settings, editable) {
  document.querySelectorAll('#mode-control button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === settings.mode));
  $('mode-hint').textContent = MODE_HINTS[settings.mode] || '';
  $('set-theme').value = settings.theme;
  $('set-maxplayers').value = settings.maxPlayers;
  $('set-maxchars').value = settings.maxChars;
  $('set-hintchars').value = settings.hintChars;
  $('set-rounds').value = settings.rounds;
  $('set-timed').checked = settings.timed;
  $('timed-detail').classList.toggle('hidden', !settings.timed);
  $('set-limitseconds').value = settings.limitSeconds;
  $('set-refreshcount').value = settings.refreshCount;
  $('set-usebank').checked = settings.useDefaultBank;
  $('set-custombank').value = settings.customBank || '';
  $('set-useemotions').checked = settings.useDefaultEmotions;
  $('set-customemotions').value = settings.customEmotions || '';
  $('set-techniques').checked = settings.useDefaultTechniques;
  $('set-customtechniques').value = settings.customTechniques || '';
  syncCustomTextareas();

  const ids = ['set-theme', 'set-maxplayers', 'set-maxchars', 'set-hintchars', 'set-rounds',
    'set-limitseconds', 'set-refreshcount', 'set-custombank', 'set-customemotions', 'set-customtechniques'];
  ids.forEach(id => { $(id).disabled = !editable; });
  document.querySelectorAll('#mode-control button').forEach(b => { b.disabled = !editable; });
  $('set-timed').disabled = !editable;
  ['set-usebank', 'set-useemotions', 'set-techniques'].forEach(id => { $(id).disabled = !editable; });

  $('challenge-extra').classList.toggle('hidden', settings.mode === 'classic');
  $('custom-extra').classList.toggle('hidden', settings.mode !== 'custom');
}

function renderLobby() {
  if (!state) return;
  // 重置上一局残留状态：否则"再来一局"后新回合的 turnKey 与上局相同，
  // 会保留旧输入内容且 autoSubmitted 卡在 true，导致无法提交
  lastTurnKey = null;
  autoSubmitted = false;
  $('write-area').value = '';
  $('char-counter').textContent = '';
  $('btn-submit').disabled = false;
  stopTimerChip();
  $('vote-modal').classList.add('hidden');

  $('lobby-code').textContent = state.code;
  $('player-count').textContent = `（${state.players.length}/${state.settings.maxPlayers}）`;

  const ul = $('player-list');
  ul.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    let html = `<span>${escapeHtml(p.name)}</span>`;
    if (p.host) html += '<span class="badge">房主</span>';
    if (!p.connected) html += '<span class="badge offline">离线</span>';
    if (state.isHost && !p.host) html += `<button class="kick-btn" data-pid="${p.pid}">移除</button>`;
    li.innerHTML = html;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('kick', { pid: btn.dataset.pid }));
  });

  applySettingsToForm(state.settings, state.isHost);
  $('settings-owner-tip').textContent = state.isHost ? '' : '（由房主设置）';

  const canStart = state.players.length >= 2;
  $('btn-start').classList.toggle('hidden', !state.isHost);
  $('btn-start').disabled = !canStart;
  $('start-tip').textContent = state.isHost
    ? (canStart ? '开始后将随机分配座次' : '至少需要 2 名玩家才能开始')
    : '等待房主开始游戏…';
}

/* ---------- 游戏 ---------- */
function seatIndex(pid) {
  return state.seats.findIndex(s => s.pid === pid);
}

function renderGame() {
  if (!state) return;
  $('game-code').textContent = state.code;
  $('round-info').textContent = `第 ${state.round}/${state.totalRounds} 轮`;

  // 座次条
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  state.seats.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'seat' + (s.pid === state.currentPid ? ' current' : '');
    div.innerHTML = `<span class="num">${i + 1}</span><span class="dot${s.connected ? '' : ' off'}"></span><span>${escapeHtml(s.name)}${s.host ? ' · 房主' : ''}</span>`;
    seatsEl.appendChild(div);
  });

  // 限时提示 & 倒计时
  $('timeout-notice').classList.toggle('hidden', !state.settings.timed);
  if (state.settings.timed) startTimerChip();
  else stopTimerChip();

  // 投票
  renderVote();
  $('pending-end-notice').classList.toggle('hidden', !state.pendingEnd);
  $('btn-propose-end').classList.toggle('hidden', !!state.vote || state.pendingEnd);

  const myTurn = state.isMyTurn;
  $('my-turn-panel').classList.toggle('hidden', !myTurn);
  $('waiting-panel').classList.toggle('hidden', myTurn);

  if (myTurn) {
    renderMyTurn();
  } else {
    $('waiting-name').textContent = state.currentName;
    const idx = seatIndex(state.me);
    $('waiting-progress').textContent = `当前进度：第 ${state.round} 轮 / 共 ${state.totalRounds} 轮`;
    $('my-seat-tip').textContent = idx >= 0 ? `你是第 ${idx + 1} 位落笔者` : '';
  }
}

function renderMyTurn() {
  const s = state;
  const turnKey = `${s.round}-${s.currentPid}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    autoSubmitted = false;
    $('write-area').value = '';
  }

  // 提示区
  if (s.hint) {
    $('hint-title').textContent = `上一位的结尾（最后 ${s.settings.hintChars} 字）`;
    $('hint-text').textContent = s.hint;
    $('hint-text').classList.remove('theme-text');
  } else {
    $('hint-title').textContent = s.settings.theme ? '本局主题' : '故事开篇';
    $('hint-text').textContent = s.settings.theme || '没有上文，由你来写下第一句。';
    $('hint-text').classList.add('theme-text');
  }

  // 限制卡
  if (s.card) {
    $('card-box').classList.remove('hidden');
    $('card-tag').textContent = s.card.type;
    $('card-content').textContent = s.card.content;
    $('card-desc').textContent = s.card.desc || cardTip(s.card);
    $('btn-refresh').textContent = s.refreshLeft > 0 ? `换一张（剩 ${s.refreshLeft} 次）` : '刷新次数已用完';
    $('btn-refresh').disabled = s.refreshLeft <= 0;
  } else {
    $('card-box').classList.add('hidden');
  }

  updateCounter();
}
function cardTip(card) {
  if (card.type === '情绪') return `请在本段落中尽量呈现「${card.content}」的情绪。`;
  return '';
}

function updateCounter() {
  const max = state ? state.settings.maxChars : 30;
  const len = charLen($('write-area').value);
  const el = $('char-counter');
  el.textContent = `${len} / ${max} 字（含标点）`;
  el.classList.toggle('over', len > max);
  $('btn-submit').disabled = len === 0 || len > max;
}

$('write-area').addEventListener('input', updateCounter);
$('btn-submit').addEventListener('click', submitMyText);
$('btn-refresh').addEventListener('click', () => socket.emit('refresh-card'));
$('btn-propose-end').addEventListener('click', () => socket.emit('propose-end'));

function submitMyText() {
  if (!state || !state.isMyTurn || autoSubmitted) return;
  autoSubmitted = true;
  socket.emit('submit-text', { text: $('write-area').value });
  $('btn-submit').disabled = true;
}

/* ---------- 倒计时 ---------- */
function startTimerChip() {
  stopTimerChip();
  const chip = $('timer-chip');
  chip.classList.remove('hidden');
  const tick = () => {
    if (!state || !state.deadline) { chip.textContent = '∞'; return; }
    const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    chip.textContent = `⏱ ${left}s`;
    chip.classList.toggle('urgent', left <= 10);
    if (state.isMyTurn && left <= 0 && !autoSubmitted) {
      submitMyText(); // 超时自动提交已输入内容
    }
  };
  tick();
  timerInt = setInterval(tick, 300);
}
function stopTimerChip() {
  if (timerInt) { clearInterval(timerInt); timerInt = null; }
  $('timer-chip').classList.add('hidden');
}

/* ---------- 投票 ---------- */
$('btn-vote-yes').addEventListener('click', () => socket.emit('vote', { accept: true }));
$('btn-vote-no').addEventListener('click', () => socket.emit('vote', { accept: false }));

function renderVote() {
  const v = state.vote;
  const modal = $('vote-modal');
  if (!v) { modal.classList.add('hidden'); return; }
  modal.classList.remove('hidden');
  const iVoted = v.myVote !== null;
  $('vote-text').innerHTML = `<b>${escapeHtml(v.proposerName)}</b> 提议现在结束本局，写出本段后收尾。<br>同意人数过半即通过。`;
  $('vote-actions').classList.toggle('hidden', iVoted);
  if (iVoted) {
    $('vote-status').textContent = v.myVote ? '你已同意，等待其他玩家投票…' : '你选择继续写，等待其他玩家投票…';
  } else {
    const update = () => {
      const left = Math.max(0, Math.ceil((v.deadline - Date.now()) / 1000));
      $('vote-status').textContent = `投票剩余 ${left} 秒`;
    };
    update();
  }
}

/* ---------- 结果页 ---------- */
function renderResult() {
  if (!state) return;
  stopTimerChip();
  $('vote-modal').classList.add('hidden');
  const hide = $('hide-extras').checked;
  const box = $('parchment');
  box.innerHTML = '';
  state.segments.forEach((seg, i) => {
    const framed = !hide && seg.card && seg.card.type !== '关键词';
    const div = document.createElement('div');
    div.className = 'seg' + (framed ? ' framed' : '');
    let html = '';

    if (!hide) {
      html += `<div class="seg-head"><span>${i + 1} · ${escapeHtml(seg.name)}</span>`;
      if (seg.card) {
        if (seg.card.type === '关键词') html += `<span class="seg-note">关键词 · ${escapeHtml(seg.card.content)}</span>`;
        else if (seg.card.type === '情绪') html += `<span class="seg-note">情绪 · ${escapeHtml(seg.card.content)}</span>`;
        else html += `<span class="seg-note">手法 · ${escapeHtml(seg.card.content)}</span>`;
      }
      html += '</div>';
    }

    let textHtml;
    if (!seg.text) {
      textHtml = hide ? '……' : '<span class="seg-empty">（这一段什么也没留下）</span>';
    } else if (!hide && seg.card && seg.card.type === '关键词') {
      const safe = escapeHtml(seg.text);
      textHtml = safe.split(escapeHtml(seg.card.content)).join(`<u>${escapeHtml(seg.card.content)}</u>`);
    } else {
      textHtml = escapeHtml(seg.text);
    }
    html += `<div class="seg-text">${textHtml}</div>`;
    div.innerHTML = html;
    box.appendChild(div);
  });

  $('btn-again').textContent = state.isHost ? '再来一局' : '等待房主开始新对局';
  $('btn-again').disabled = !state.isHost;
  box.scrollTop = 0;
}

$('hide-extras').addEventListener('change', () => {
  if (state && state.phase === 'ended') renderResult();
});

$('btn-again').addEventListener('click', () => {
  if (state && state.isHost) socket.emit('play-again');
});
$('btn-exit-result').addEventListener('click', () => $('lobby-leave').click());

/* ---------- 下载 txt ---------- */
$('btn-download').addEventListener('click', () => {
  if (!state || state.phase !== 'ended') return;
  const hide = $('hide-extras').checked;
  const s = state.settings;
  const lines = [];
  lines.push(`【故事接龙】房间 ${state.code}`);
  lines.push(`主题：${s.theme || '（无）'}`);
  if (!hide) lines.push(`模式：${s.mode === 'classic' ? '经典模式' : s.mode === 'challenge' ? '挑战模式' : '自定义模式'}`);
  lines.push('');
  state.segments.forEach((seg, i) => {
    if (hide) {
      // 隐藏附加信息：只输出正文，不显示作者与限制条件
      if (seg.text) {
        lines.push(seg.text);
        lines.push('');
      }
      return;
    }
    lines.push(`— 第 ${i + 1} 段 · ${seg.name} —`);
    lines.push(seg.text || '（这一段什么也没留下）');
    if (seg.card) {
      if (seg.card.type === '关键词') lines.push(`（本段包含关键词：${seg.card.content}）`);
      else if (seg.card.type === '情绪') lines.push(`（本段情绪：${seg.card.content}）`);
      else lines.push(`（本段手法：${seg.card.content}）`);
    }
    lines.push('');
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `故事接龙_${state.code}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已保存到本地');
});
