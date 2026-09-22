/**
 * 우리 반 윷놀이 클라이언트.
 *  - 경로:  /            시작 화면
 *           /host        새 방 만들기 → /host/1234 로 이동
 *           /host/1234   선생님 화면 (이 기기에 저장된 선생님 토큰으로 재접속)
 *           /r/1234      학생 입장 (QR 코드가 여기로 연결)
 *  - 서버 상태(state)는 순서대로 큐에 넣어 처리하며, 윷 던지기 이벤트는 애니메이션이 끝날 때까지 다음 상태를 기다린다.
 */
import { createBoard } from './board.js';
import { mountTossPage } from './toss.js';

const SESSION_KEY = 'yut.session.v1';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const TOSS_ROLL_MS = 1100;
const TOSS_REVEAL_MS = 450;
const TOSS_RESULT_MS = 1500;
const MOVE_SETTLE_MS = 750;
const TOAST_MS = 2600;
const CALLOUT_MS = 1400;
const JOIN_TIMEOUT_MS = 6000;
const DEFAULT_SETTINGS = { teamCount: 2, piecesPerTeam: 2, backdo: false };

const ADJECTIVES = ['용감한', '씩씩한', '반짝이는', '신나는', '귀여운', '재빠른', '똑똑한', '행복한', '든든한', '멋진'];
const ANIMALS = ['다람쥐', '펭귄', '고양이', '강아지', '코알라', '판다', '여우', '돌고래', '부엉이', '수달', '기린', '햄스터'];

const appEl = document.getElementById('app');
const connBanner = document.getElementById('conn-banner');
const toastEl = document.getElementById('toast');
const calloutEl = document.getElementById('callout');
const tossOverlay = document.getElementById('toss-overlay');

const state = {
  route: parseRoute(location.pathname),
  ws: null,
  connected: false,
  reconnectDelay: RECONNECT_MIN_MS,
  session: loadSession(),
  pendingAuth: null,
  authFailed: false,
  authError: null,
  role: null,
  code: null,
  myPlayerId: null,
  room: null,
  busy: false,
  replaced: false,
  joining: false,
  nickDraft: null,
  tossPage: null,
  memberMenu: null,
  joinError: null,
};

const board = createBoard((option) => {
  send({ type: 'game:move', choice: option });
});

// ---------------------------------------------------------------------------
// 라우팅 / 세션
// ---------------------------------------------------------------------------

function parseRoute(pathname) {
  let match = pathname.match(/^\/host\/(\d{4})$/);
  if (match) {
    return { kind: 'host', code: match[1] };
  }
  if (pathname === '/host') {
    return { kind: 'host', code: null };
  }
  match = pathname.match(/^\/r\/(\d{4})$/);
  if (match) {
    return { kind: 'player', code: match[1] };
  }
  // 예전 반별 주소(/toss/3-1)도 같은 화면으로 연다
  if (pathname === '/toss' || pathname.startsWith('/toss/')) {
    return { kind: 'toss' };
  }
  return { kind: 'landing' };
}

/** 윷 던지기 전용 모드와 시작 화면은 서버 연결 없이 동작한다. 선생님/학생 화면으로 갈 때 연결한다. */
function needsSocket(route) {
  return route.kind !== 'toss' && route.kind !== 'landing';
}

function navigate(pathname) {
  history.pushState(null, '', pathname);
  state.route = parseRoute(pathname);
  state.room = null;
  state.role = null;
  state.authFailed = false;
  state.joinError = null;
  preparePendingAuth();
  if (needsSocket(state.route) && !state.replaced) {
    connect();
  }
  flushPendingAuth();
  render();
}

window.addEventListener('popstate', () => {
  state.route = parseRoute(location.pathname);
  state.room = null;
  state.role = null;
  state.authFailed = false;
  preparePendingAuth();
  if (needsSocket(state.route) && !state.replaced) {
    connect();
  }
  flushPendingAuth();
  render();
});

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}') || {};
  } catch {
    return {};
  }
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } catch {
    // 사생활 보호 모드 등에서는 저장이 막힐 수 있다. 저장 없이도 게임은 진행된다.
  }
}

/** 현재 경로에서 접속 즉시 보낼 인증 메시지를 정한다. */
function preparePendingAuth() {
  const { route, session } = state;
  state.pendingAuth = null;
  if (route.kind === 'host') {
    if (route.code === null) {
      state.pendingAuth = { type: 'host:create', settings: DEFAULT_SETTINGS };
    } else if (session.host?.code === route.code) {
      state.pendingAuth = { type: 'host:rejoin', code: route.code, hostToken: session.host.hostToken };
    } else {
      state.authFailed = true;
    }
  } else if (route.kind === 'player' && session.player?.code === route.code) {
    state.pendingAuth = {
      type: 'player:rejoin',
      code: route.code,
      playerId: session.player.playerId,
      token: session.player.token,
    };
  }
}

function flushPendingAuth() {
  if (state.pendingAuth && state.connected) {
    send(state.pendingAuth);
    state.pendingAuth = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let reconnectTimer = null;

function connect() {
  if (state.ws) {
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    state.reconnectDelay = RECONNECT_MIN_MS;
    connBanner.classList.add('hidden');
    // 끊겼다가 다시 붙었을 때는 이전 역할로 다시 인증한다
    if (!state.pendingAuth && state.role) {
      state.pendingAuth = reauthMessage();
    }
    flushPendingAuth();
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  ws.addEventListener('close', () => {
    if (state.ws !== ws) {
      return;
    }
    state.connected = false;
    state.ws = null;
    if (state.replaced) {
      // 다른 탭/기기에서 같은 화면을 열었다. 서로 밀어내지 않도록 여기서는 다시 붙지 않는다.
      return;
    }
    if (state.role || (needsSocket(state.route) && state.route.kind !== 'landing')) {
      connBanner.classList.remove('hidden');
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(RECONNECT_MAX_MS, state.reconnectDelay * 2);
  });
}

function reauthMessage() {
  if (state.role === 'host' && state.session.host) {
    return { type: 'host:rejoin', code: state.session.host.code, hostToken: state.session.host.hostToken };
  }
  if (state.role === 'player' && state.session.player) {
    return {
      type: 'player:rejoin',
      code: state.session.player.code,
      playerId: state.session.player.playerId,
      token: state.session.player.token,
    };
  }
  return null;
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast('연결 중이에요. 잠시만 기다려 주세요…');
    return;
  }
  state.ws.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// 메시지 처리 (state 는 순서대로, 애니메이션을 기다리며 처리)
// ---------------------------------------------------------------------------

const queue = [];
let pumping = false;

function handleMessage(message) {
  switch (message.type) {
    case 'host:created':
      state.role = 'host';
      state.code = message.code;
      state.session.host = { code: message.code, hostToken: message.hostToken };
      saveSession();
      if (state.route.kind !== 'host' || state.route.code !== message.code) {
        history.replaceState(null, '', `/host/${message.code}`);
        state.route = parseRoute(location.pathname);
      }
      return;
    case 'player:joined':
      state.joining = false;
      state.role = 'player';
      state.code = message.code;
      state.myPlayerId = message.playerId;
      state.session.player = { code: message.code, playerId: message.playerId, token: message.token };
      saveSession();
      state.joinError = null;
      return;
    case 'state':
      queue.push(message);
      pump();
      return;
    case 'error':
      handleError(message.message);
      return;
    case 'replaced':
      state.replaced = true;
      state.role = null;
      connBanner.classList.add('hidden');
      render();
      return;
    case 'kicked':
      delete state.session.player;
      saveSession();
      state.role = null;
      state.room = null;
      toast('선생님이 방에서 내보냈어요.');
      navigate('/');
      return;
    default:
      return;
  }
}

function handleError(text) {
  state.joining = false;
  if (!state.role) {
    // 재접속 실패: 저장된 정보가 더는 유효하지 않다
    if (state.route.kind === 'player') {
      delete state.session.player;
      saveSession();
      state.joinError = text;
    } else if (state.route.kind === 'host') {
      delete state.session.host;
      saveSession();
      state.authFailed = true;
      state.authError = text;
    }
    render();
  }
  toast(text);
}

async function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  while (queue.length > 0) {
    const message = queue.shift();
    await applyState(message);
  }
  pumping = false;
}

async function applyState({ room, event }) {
  if (event?.kind === 'toss') {
    state.busy = true;
    render();
    await playToss(event, room);
  }
  state.room = room;
  state.busy = false;
  render();
  if (event?.kind === 'move') {
    const shown = showMoveCallout(event, room);
    await sleep(shown ? CALLOUT_MS : MOVE_SETTLE_MS);
  }
}

// ---------------------------------------------------------------------------
// 윷 던지기 애니메이션
// ---------------------------------------------------------------------------

function playToss(event, room) {
  const team = room.teams[event.teamIndex];
  const card = tossOverlay.querySelector('.toss-card');
  const sticks = [...tossOverlay.querySelectorAll('.stick')];
  const resultEl = tossOverlay.querySelector('.toss-result');
  const subEl = tossOverlay.querySelector('.toss-sub');
  tossOverlay.querySelector('.toss-team').textContent = `${team.emoji} ${team.name}이(가) 던져요`;
  card.style.setProperty('--team-color', team.color);
  resultEl.textContent = '';
  subEl.textContent = '';
  for (const stick of sticks) {
    stick.className = 'stick';
  }
  if (room.settings.backdo) {
    sticks[0].classList.add('marked');
  }
  card.classList.add('rolling');
  card.classList.remove('show-result');
  tossOverlay.classList.remove('hidden');

  return new Promise((resolve) => {
    let finished = false;
    const timers = [];
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      timers.forEach(clearTimeout);
      tossOverlay.classList.add('hidden');
      card.classList.remove('rolling', 'show-result');
      tossOverlay.onclick = null;
      resolve();
    };
    tossOverlay.onclick = finish;
    timers.push(
      setTimeout(() => {
        card.classList.remove('rolling');
        event.flats.forEach((flat, i) => sticks[i].classList.add(flat ? 'flat' : 'round'));
        timers.push(
          setTimeout(() => {
            card.classList.add('show-result');
            resultEl.textContent = `${event.result.name}!`;
            subEl.textContent = describeToss(event);
            timers.push(setTimeout(finish, TOSS_RESULT_MS));
          }, TOSS_REVEAL_MS),
        );
      }, TOSS_ROLL_MS),
    );
  });
}

function describeToss(event) {
  if (event.skipped) {
    return '움직일 말이 없어요 😢';
  }
  if (event.result.steps < 0) {
    return '뒤로 한 칸!';
  }
  return `${event.result.steps}칸 앞으로${event.result.again ? ' · 한 번 더! 🎉' : ''}`;
}

function showMoveCallout(event, room) {
  const team = room.teams[event.teamIndex];
  let text = null;
  if (event.won) {
    text = `🏆 ${team.emoji} ${team.name} 승리!`;
  } else if (event.finished) {
    text = '났다! 🎉';
  } else if (event.caught?.length > 0) {
    text = '잡았다! 😈';
  }
  if (!text) {
    return false;
  }
  calloutEl.textContent = text;
  calloutEl.style.setProperty('--team-color', team.color);
  calloutEl.classList.remove('hidden');
  clearTimeout(calloutEl.timer);
  calloutEl.timer = setTimeout(() => calloutEl.classList.add('hidden'), CALLOUT_MS);
  return true;
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastEl.timer);
  toastEl.timer = setTimeout(() => toastEl.classList.add('hidden'), TOAST_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

function render() {
  const { route, room, role } = state;
  if (route.kind === 'toss') {
    if (state.tossPage) {
      return;
    }
    appEl.innerHTML = '';
    connBanner.classList.add('hidden');
    state.tossPage = mountTossPage(appEl, { onLeave: () => navigate('/') });
    return;
  }
  unmountToss();
  let html;
  if (state.replaced) {
    html = renderReplaced();
  } else if (route.kind === 'landing') {
    html = renderLanding();
  } else if (route.kind === 'host') {
    if (state.authFailed) {
      html = renderHostLost();
    } else if (!room || role !== 'host') {
      html = renderLoading('방을 준비하는 중…');
    } else if (room.status === 'LOBBY') {
      html = renderHostLobby(room);
    } else {
      html = renderHostGame(room);
    }
  } else if (route.kind === 'player') {
    if (role !== 'player' || !room) {
      html = state.pendingAuth ? renderLoading('다시 들어가는 중…') : renderJoinForm(route.code);
    } else if (room.status === 'LOBBY') {
      html = renderPlayerLobby(room);
    } else {
      html = renderPlayerGame(room);
    }
  }
  appEl.innerHTML = html;
  mountBoard();
  bindActions();
}

function unmountToss() {
  if (state.tossPage) {
    state.tossPage.unmount();
    state.tossPage = null;
  }
}

function mountBoard() {
  const slot = appEl.querySelector('.board-slot');
  if (!slot || !state.room) {
    return;
  }
  slot.append(board.svg);
  // 재삽입 직후 강제로 스타일을 계산해 두면 이어지는 transform 변경이 트랜지션으로 이어진다
  board.svg.getBoundingClientRect();
  const room = state.room;
  board.update(room, {
    options: room.turn?.options ?? [],
    canAct: canAct(room) && !state.busy,
    actingTeam: room.turn ? room.teams[room.turn.teamIndex] : null,
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function teamStyle(team) {
  const color = esc(team.color);
  return `style="--team-color:${color};--team-tint:${color}1a;--team-soft:${color}66"`;
}

function myTeamIndex(room) {
  if (state.role !== 'player') {
    return null;
  }
  const team = room.teams.find((t) => t.members.some((m) => m.id === state.myPlayerId));
  return team ? team.index : null;
}

/** 지금 이 화면이 윷을 던지거나 말을 고를 수 있는가 */
function canAct(room) {
  if (room.status !== 'PLAYING' || !room.turn) {
    return false;
  }
  if (state.role === 'host') {
    return true;
  }
  if (myTeamIndex(room) !== room.turn.teamIndex) {
    return false;
  }
  return room.turn.activePlayerId === null || room.turn.activePlayerId === state.myPlayerId;
}

function pieceSummary(team) {
  const waiting = team.pieces.filter((p) => !p.done && p.node === null).length;
  const running = team.pieces.filter((p) => !p.done && p.node !== null).length;
  const done = team.pieces.filter((p) => p.done).length;
  return `<div class="pieces"><span title="출발 전">🏠 ${waiting}</span><span title="달리는 중">🏃 ${running}</span><span title="도착">🏁 ${done}</span></div>`;
}

function renderLoading(text) {
  return `<div class="loading"><div class="spinner">🎲</div><div>${esc(text)}</div></div>`;
}

// ---- 시작 화면 -------------------------------------------------------------

function renderLanding() {
  return `
    <div class="landing">
      <p class="hero">🎲</p>
      <h1 class="title">우리 반 윷놀이<small>반 친구들과 함께하는 전통 놀이</small></h1>
      <section class="card toss-entry">
        <h2>🥢 윷 던지기</h2>
        <button class="btn btn-primary btn-xl" data-action="go-toss">윷 던지기 시작</button>
      </section>
    </div>`;
}

/*
 * 온라인 윷판 모드 입구 (👩‍🏫 선생님 게임방 만들기 · 🧒 학생 들어가기).
 * 실물 윷판만 쓰는 동안 시작 화면에서 숨겨 둔다. /host, /r/1234 주소로는 여전히 동작한다.
 * 다시 보이려면 아래 주석을 풀고 renderLanding 의 윷 던지기 카드 아래에 `${renderOnlineEntry()}` 를 넣는다.
 */
// function renderOnlineEntry() {
//   const { session } = state;
//   return `
//       <h2 class="center muted" style="font-size:1rem;margin:4px 0 12px">— 또는 윷판까지 화면으로 함께 하기 —</h2>
//       <section class="card">
//         <h2>👩‍🏫 선생님</h2>
//         <p>게임방을 만들면 QR 코드와 방 코드가 나와요. 학생들이 찍고 들어오면 시작!</p>
//         <button class="btn btn-primary btn-xl" data-action="create-room">게임방 만들기</button>
//         ${session.host ? `<button class="btn btn-ghost" data-action="resume-host">이어서 하기 (방 ${esc(session.host.code)})</button>` : ''}
//       </section>
//       <section class="card student">
//         <h2>🧒 학생</h2>
//         <p>선생님 화면의 QR 코드를 찍거나, 방 코드 4자리를 넣어요.</p>
//         <div class="row">
//           <input class="input input-code grow" id="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" autocomplete="off" />
//           <button class="btn btn-secondary" data-action="join-code">들어가기</button>
//         </div>
//         ${session.player ? `<button class="btn btn-ghost" data-action="resume-player">이어서 하기 (방 ${esc(session.player.code)})</button>` : ''}
//       </section>`;
// }

function renderReplaced() {
  return `
    <div class="landing">
      <p class="hero">👀</p>
      <h1 class="title">다른 화면에서 열렸어요<small>같은 방을 다른 탭이나 기기에서 열었어요. 이 화면은 닫아도 돼요.</small></h1>
      <section class="card">
        <div class="row">
          <button class="btn btn-primary grow" data-action="take-over">여기서 이어서 하기</button>
          <button class="btn grow" data-action="go-home">시작 화면</button>
        </div>
      </section>
    </div>`;
}

function renderHostLost() {
  return `
    <div class="landing">
      <h1 class="title">😮 이 기기에 선생님 정보가 없어요</h1>
      <section class="card">
        ${state.authError ? `<p style="color:var(--danger);font-weight:700">${esc(state.authError)}</p>` : ''}
        <p>방 ${esc(state.route.code ?? '')}의 선생님 화면은 방을 만든 기기에서만 다시 열 수 있고, 서버가 다시 시작되면 방이 사라져요. 새 방을 만들거나 시작 화면으로 돌아가요.</p>
        <div class="row">
          ${state.route.code ? `<button class="btn btn-primary grow" data-action="recreate-room">방 코드 ${esc(state.route.code)}로 다시 만들기</button>` : ''}
          <button class="btn grow" data-action="create-room">새 게임방 만들기</button>
          <button class="btn grow" data-action="go-home">시작 화면</button>
        </div>
        ${state.route.code ? '<p class="muted" style="margin-top:10px">같은 코드로 다시 만들면 이미 나눠 준 QR 코드와 방 코드를 그대로 쓸 수 있어요. 학생들은 다시 들어와야 해요.</p>' : ''}
      </section>
    </div>`;
}

// ---- 선생님 로비 -----------------------------------------------------------

function renderCodeCard(room, compact = false) {
  if (compact) {
    return `
      <div class="mini-join">
        <img src="/qr/${esc(room.code)}.svg" alt="입장 QR 코드" />
        <div><div class="muted">방 코드</div><div class="code">${esc(room.code)}</div><div class="muted">${esc(room.joinUrl)}</div></div>
      </div>`;
  }
  return `
    <section class="card code-card">
      <div class="label">방 코드</div>
      <div class="code">${esc(room.code)}</div>
      <img class="qr" src="/qr/${esc(room.code)}.svg" alt="입장 QR 코드" />
      <div class="url">${esc(room.joinUrl)}</div>
      <p class="muted">학생들은 QR 코드를 찍거나 시작 화면에서 코드를 넣으면 들어와요.</p>
    </section>`;
}

function renderSettings(room) {
  const { settings } = room;
  const seg = (name, values, current) =>
    `<div class="seg" data-setting="${name}">${values
      .map((v) => `<button class="${v === current ? 'active' : ''}" data-value="${v}">${v}</button>`)
      .join('')}</div>`;
  return `
    <section class="card">
      <h2>⚙️ 게임 설정</h2>
      <div class="setting-row"><div class="label">팀 수<small>반을 몇 팀으로 나눌까요?</small></div>${seg('teamCount', [2, 3, 4], settings.teamCount)}</div>
      <div class="setting-row"><div class="label">팀당 말 개수<small>적을수록 빨리 끝나요 (수업 시간엔 2개 추천)</small></div>${seg('piecesPerTeam', [1, 2, 3, 4], settings.piecesPerTeam)}</div>
      <div class="setting-row"><div class="label">백도<small>★ 가락 하나만 배면 뒤로 1칸</small></div>
        <div class="seg" data-setting="backdo"><button class="${settings.backdo ? '' : 'active'}" data-value="false">끄기</button><button class="${settings.backdo ? 'active' : ''}" data-value="true">켜기</button></div></div>
    </section>`;
}

function renderMemberChip(member, { clickable = false, me = false } = {}) {
  const classes = ['chip', member.connected ? '' : 'offline', clickable ? 'clickable' : '', me ? 'me' : ''].join(' ');
  return `<span class="${classes}" ${clickable ? `data-action="member-menu" data-player="${esc(member.id)}"` : ''}><i class="dot"></i>${esc(member.nickname)}</span>`;
}

function renderMemberMenu(room, playerId) {
  const team = room.teams.find((t) => t.members.some((m) => m.id === playerId));
  const member = team?.members.find((m) => m.id === playerId);
  if (!member) {
    return '';
  }
  const others = room.teams.filter((t) => t.index !== team.index);
  return `
    <div class="member-menu">
      <b>${esc(member.nickname)}</b> 친구를…
      <div class="row">
        ${others.map((t) => `<button class="btn btn-sm" data-action="move-member" data-player="${esc(playerId)}" data-team="${t.index}">${t.emoji} ${esc(t.name)}으로</button>`).join('')}
        <button class="btn btn-sm btn-danger" data-action="kick-member" data-player="${esc(playerId)}">내보내기</button>
        <button class="btn btn-sm btn-ghost" data-action="close-member-menu">닫기</button>
      </div>
    </div>`;
}

function renderHostLobby(room) {
  const totalPlayers = room.teams.reduce((sum, t) => sum + t.members.length, 0);
  return `
    <h1 class="title">👩‍🏫 선생님 화면 <small>학생들이 들어오면 시작하기를 눌러요</small></h1>
    <div class="lobby">
      <div>${renderCodeCard(room)}</div>
      <div>
        ${renderSettings(room)}
        <section class="card">
          <h2>🙋 들어온 학생 (${totalPlayers}명) <span class="muted" style="font-size:.9rem;font-weight:500">— 이름을 누르면 팀을 옮길 수 있어요</span></h2>
          <div class="team-grid">
            ${room.teams
              .map(
                (team) => `
              <div class="team-card" ${teamStyle(team)}>
                <header><span>${team.emoji} ${esc(team.name)}</span><span class="count">${team.members.length}명</span></header>
                <div class="members">${team.members.length === 0 ? '<span class="empty">아직 없어요</span>' : team.members.map((m) => renderMemberChip(m, { clickable: true })).join('')}</div>
              </div>`,
              )
              .join('')}
          </div>
          ${state.memberMenu ? renderMemberMenu(room, state.memberMenu) : ''}
        </section>
        <section class="card">
          <div class="row">
            <button class="btn grow" data-action="toggle-lock">${room.locked ? '🔒 잠금 풀기' : '🔓 방 잠그기'}</button>
            <button class="btn btn-primary btn-xl grow" data-action="start-game">▶ 게임 시작!</button>
          </div>
          <p class="muted" style="margin-top:10px">${room.locked ? '지금은 새 학생이 들어올 수 없어요.' : '학생이 아직 없어도 선생님이 대신 던지며 진행할 수 있어요.'}</p>
        </section>
      </div>
    </div>`;
}

// ---- 게임 화면 (공통 조각) --------------------------------------------------

function renderTurnBanner(room, { mine = false } = {}) {
  if (!room.turn) {
    return '';
  }
  const team = room.teams[room.turn.teamIndex];
  const phaseText = room.turn.phase === 'TOSS' ? '윷을 던질 차례' : '말을 고를 차례';
  const who = room.turn.activeNickname ? `${room.turn.activeNickname} 친구가 ${phaseText}` : `선생님이 ${phaseText}`;
  return `
    <div class="turn-banner ${mine ? 'mine' : ''}" ${teamStyle(team)}>
      <div>${team.emoji} ${esc(team.name)} 차례<small>${mine ? `내 차례! ${phaseText}예요 👉` : esc(who) + '예요'}</small></div>
      <div style="font-size:2rem">${room.turn.phase === 'TOSS' ? '🎲' : '👆'}</div>
    </div>`;
}

function renderOptionButtons(room) {
  if (!room.turn || room.turn.phase !== 'MOVE') {
    return '';
  }
  const team = room.teams[room.turn.teamIndex];
  return `<div class="option-list" ${teamStyle(team)}>${room.turn.options
    .map((option) => {
      const label = option.kind === 'new' ? '🆕 새 말 출발' : `${option.node}번 칸 말${option.pieceIds.length > 1 ? ` (${option.pieceIds.length}개 업힘)` : ''}`;
      let dest;
      if (option.dest.done) {
        dest = '🏁 도착!';
      } else if (option.dest.node === null) {
        dest = '🏠 처음으로';
      } else if (room.teams.some((t) => t.index !== team.index && t.pieces.some((p) => !p.done && p.node === option.dest.node))) {
        dest = `${option.dest.node}번 칸 😈 잡기!`;
      } else {
        dest = `${option.dest.node}번 칸`;
      }
      return `<button class="btn option-btn" data-action="pick-option" data-kind="${option.kind}" data-node="${option.node ?? ''}"><span>${esc(label)}</span><span class="arrow">→ ${esc(dest)}</span></button>`;
    })
    .join('')}</div>`;
}

function renderLog(room, count) {
  return `<div class="log">${room.log.slice(-count).map((line) => `<div>${esc(line)}</div>`).join('')}</div>`;
}

function renderTeamStatusCards(room, { clickableMembers = false } = {}) {
  const myTeam = myTeamIndex(room);
  return `<div class="team-grid">${room.teams
    .map((team) => {
      const isTurn = room.turn?.teamIndex === team.index;
      return `
        <div class="team-card ${isTurn ? 'active-turn' : ''} ${myTeam === team.index ? 'mine' : ''}" ${teamStyle(team)}>
          <header><span>${team.emoji} ${esc(team.name)}</span><span class="count">${team.members.length}명</span></header>
          ${pieceSummary(team)}
          <div class="members">${team.members
            .map((m) =>
              renderMemberChip(m, { clickable: clickableMembers, me: m.id === state.myPlayerId }).replace(
                'class="chip',
                `class="chip ${room.turn?.activePlayerId === m.id ? 'active' : ''}`,
              ),
            )
            .join('')}</div>
        </div>`;
    })
    .join('')}</div>`;
}

function renderFinishOverlay(room, isHost) {
  if (room.status !== 'FINISHED' || room.winnerTeamIndex === null) {
    return '';
  }
  const team = room.teams[room.winnerTeamIndex];
  const confetti = Array.from({ length: 24 }, (_, i) => {
    const left = (i * 41) % 100;
    const delay = (i % 8) * 0.35;
    const duration = 3 + (i % 5) * 0.6;
    const color = room.teams[i % room.teams.length].color;
    return `<i class="confetti" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;background:${esc(color)}"></i>`;
  }).join('');
  return `
    <div class="finish-overlay" ${teamStyle(team)}>
      ${confetti}
      <div class="trophy">🏆</div>
      <h1>${team.emoji} ${esc(team.name)} 승리!</h1>
      <p style="font-size:1.3rem;font-weight:700">모두 잘했어요! 👏👏👏</p>
      ${
        isHost
          ? `<div class="row"><button class="btn btn-primary btn-xl" data-action="start-game">🔁 다시 하기</button><button class="btn" data-action="to-lobby">로비로</button></div>`
          : `<p class="muted">선생님이 다음 게임을 준비해요 ⏳</p>`
      }
    </div>`;
}

// ---- 선생님 게임 화면 -------------------------------------------------------

function renderHostGame(room) {
  const phase = room.turn?.phase;
  const hostCanToss = phase === 'TOSS' && !state.busy;
  return `
    <div class="game host">
      <div class="game-board board-slot"></div>
      <aside class="controls">
        ${renderTurnBanner(room)}
        <div class="card" style="margin:0">
          ${hostCanToss ? `<button class="btn btn-secondary" style="width:100%" data-action="toss">🎲 선생님이 대신 던지기</button>` : ''}
          ${phase === 'MOVE' && !state.busy ? `<div class="hint">말을 골라요 (선생님도 대신 고를 수 있어요)</div>${renderOptionButtons(room)}` : ''}
          <div class="host-actions" style="margin-top:10px">
            <button class="btn btn-sm" data-action="skip-turn">⏭ 차례 넘기기</button>
            <button class="btn btn-sm" data-action="toggle-lock">${room.locked ? '🔒 잠금 풀기' : '🔓 방 잠그기'}</button>
            <button class="btn btn-sm btn-danger" data-action="to-lobby">⏹ 게임 끝내고 로비로</button>
          </div>
        </div>
        ${renderTeamStatusCards(room, { clickableMembers: true })}
        ${state.memberMenu ? renderMemberMenu(room, state.memberMenu) : ''}
        ${renderLog(room, 6)}
        ${renderCodeCard(room, true)}
      </aside>
    </div>
    ${renderFinishOverlay(room, true)}`;
}

// ---- 학생 화면 ---------------------------------------------------------------

function renderJoinForm(code) {
  state.nickDraft ??= randomNickname();
  return `
    <div class="landing">
      <p class="hero">🧒</p>
      <h1 class="title">방 ${esc(code)}에 들어가요<small>별명을 정하고 들어가기를 눌러요</small></h1>
      <section class="card student">
        ${state.joinError ? `<p style="color:var(--danger);font-weight:700">${esc(state.joinError)}</p>` : ''}
        <label for="nick-input" style="font-weight:700">별명 (진짜 이름 대신 재미있는 별명을 써요)</label>
        <div class="row" style="margin-top:8px">
          <input class="input grow" id="nick-input" maxlength="10" placeholder="예: 용감한 다람쥐" autocomplete="off" value="${esc(state.nickDraft)}" />
          <button class="btn" data-action="random-nick" title="다른 별명">🎲</button>
        </div>
        <button class="btn btn-secondary btn-xl" style="margin-top:14px" data-action="join" ${state.joining ? 'disabled' : ''}>${state.joining ? '들어가는 중…' : '들어가기'}</button>
        <p class="muted" style="margin-top:10px">팀은 자동으로 정해져요. 들어간 뒤에 바꿀 수 있어요.</p>
      </section>
      <p class="center"><button class="btn btn-ghost" data-action="go-home">시작 화면으로</button></p>
    </div>`;
}

function renderPlayerLobby(room) {
  const myTeam = myTeamIndex(room);
  const me = room.teams.flatMap((t) => t.members).find((m) => m.id === state.myPlayerId);
  const team = room.teams[myTeam] ?? room.teams[0];
  return `
    <h1 class="title">${team.emoji} ${esc(team.name)}에 들어왔어요!<small>${esc(me?.nickname ?? '')} · 선생님이 시작하면 자동으로 게임이 시작돼요 ⏳</small></h1>
    <div class="team-grid">
      ${room.teams
        .map(
          (t) => `
        <div class="team-card ${t.index === myTeam ? 'mine' : ''}" ${teamStyle(t)}>
          <header><span>${t.emoji} ${esc(t.name)}</span><span class="count">${t.members.length}명</span></header>
          <div class="members">${t.members.length === 0 ? '<span class="empty">아직 없어요</span>' : t.members.map((m) => renderMemberChip(m, { me: m.id === state.myPlayerId })).join('')}</div>
          ${t.index !== myTeam ? `<button class="btn btn-sm" style="margin-top:10px" data-action="change-team" data-team="${t.index}">이 팀으로 바꾸기</button>` : ''}
        </div>`,
        )
        .join('')}
    </div>
    <p class="center" style="margin-top:20px"><button class="btn btn-ghost" data-action="leave">나가기</button></p>`;
}

function renderPlayerGame(room) {
  const mine = canAct(room);
  const myTeam = myTeamIndex(room);
  const phase = room.turn?.phase;
  let controls = '';
  if (room.status === 'PLAYING' && room.turn) {
    if (state.busy) {
      controls = `<div class="hint">🎲 두구두구…</div>`;
    } else if (mine && phase === 'TOSS') {
      controls = `<button class="btn btn-toss" data-action="toss">🎲 윷 던지기!</button>`;
    } else if (mine && phase === 'MOVE') {
      controls = `<div class="hint">움직일 말을 골라요 👇 (윷판의 말을 눌러도 돼요)</div>${renderOptionButtons(room)}`;
    } else if (room.turn.teamIndex === myTeam) {
      controls = `<div class="hint">같은 팀 ${esc(room.turn.activeNickname ?? '친구')}가 던져요. 응원해요! 📣</div>`;
    } else {
      controls = `<div class="hint muted">${room.teams[room.turn.teamIndex].emoji} ${esc(room.teams[room.turn.teamIndex].name)} 차례예요. 기다려요 ⏳</div>`;
    }
  }
  return `
    <div class="game player">
      ${renderTurnBanner(room, { mine })}
      <div class="game-board board-slot"></div>
      <div class="controls card" style="margin:0">${controls}</div>
      ${renderTeamStatusCards(room)}
      ${renderLog(room, 3)}
    </div>
    ${renderFinishOverlay(room, false)}`;
}

function randomNickname() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

// ---------------------------------------------------------------------------
// 이벤트 바인딩
// ---------------------------------------------------------------------------

function bindActions() {
  appEl.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', onAction);
  });
  appEl.querySelectorAll('.seg[data-setting] button').forEach((button) => {
    button.addEventListener('click', () => {
      const setting = button.closest('.seg').dataset.setting;
      const raw = button.dataset.value;
      const value = setting === 'backdo' ? raw === 'true' : Number(raw);
      send({ type: 'host:settings', settings: { [setting]: value } });
    });
  });
  const codeInput = appEl.querySelector('#code-input');
  if (codeInput) {
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        joinWithCode();
      }
    });
    if (document.activeElement !== codeInput && !codeInput.value) {
      codeInput.focus();
    }
  }
  const nickInput = appEl.querySelector('#nick-input');
  if (nickInput) {
    nickInput.addEventListener('input', () => {
      state.nickDraft = nickInput.value;
    });
    nickInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        joinRoom();
      }
    });
  }
}

function onAction(event) {
  const element = event.currentTarget;
  const { action } = element.dataset;
  switch (action) {
    case 'create-room':
      navigate('/host');
      break;
    case 'resume-host':
      navigate(`/host/${state.session.host.code}`);
      break;
    case 'resume-player':
      navigate(`/r/${state.session.player.code}`);
      break;
    case 'join-code':
      joinWithCode();
      break;
    case 'go-home':
      state.replaced = false;
      navigate('/');
      if (!state.ws) {
        connect();
      }
      break;
    case 'take-over':
      state.replaced = false;
      preparePendingAuth();
      if (state.ws) {
        flushPendingAuth();
      } else {
        connect();
      }
      render();
      break;
    case 'go-toss':
      navigate('/toss');
      break;
    case 'random-nick': {
      state.nickDraft = randomNickname();
      appEl.querySelector('#nick-input').value = state.nickDraft;
      break;
    }
    case 'recreate-room':
      state.authFailed = false;
      state.authError = null;
      state.pendingAuth = { type: 'host:create', settings: DEFAULT_SETTINGS, preferredCode: state.route.code };
      if (state.ws) {
        flushPendingAuth();
      } else {
        connect();
      }
      render();
      break;
    case 'join':
      joinRoom();
      break;
    case 'change-team':
      send({ type: 'player:team', teamIndex: Number(element.dataset.team) });
      break;
    case 'leave':
      delete state.session.player;
      saveSession();
      state.role = null;
      state.room = null;
      if (state.ws) {
        state.ws.close();
      }
      navigate('/');
      break;
    case 'start-game':
      send({ type: 'host:start' });
      break;
    case 'to-lobby':
      send({ type: 'host:lobby' });
      break;
    case 'skip-turn':
      send({ type: 'host:skip' });
      break;
    case 'toggle-lock':
      send({ type: 'host:lock', locked: !state.room?.locked });
      break;
    case 'toss':
      send({ type: 'game:toss' });
      break;
    case 'pick-option':
      send({
        type: 'game:move',
        choice: { kind: element.dataset.kind, node: element.dataset.node === '' ? null : Number(element.dataset.node) },
      });
      break;
    case 'member-menu':
      state.memberMenu = element.dataset.player;
      render();
      break;
    case 'close-member-menu':
      state.memberMenu = null;
      render();
      break;
    case 'move-member':
      send({ type: 'host:move-player', playerId: element.dataset.player, teamIndex: Number(element.dataset.team) });
      state.memberMenu = null;
      break;
    case 'kick-member':
      send({ type: 'host:kick', playerId: element.dataset.player });
      state.memberMenu = null;
      break;
    default:
      break;
  }
}

function joinWithCode() {
  const input = appEl.querySelector('#code-input');
  const code = (input?.value ?? '').replace(/\D/g, '');
  if (code.length !== 4) {
    toast('방 코드는 숫자 4자리예요.');
    input?.focus();
    return;
  }
  navigate(`/r/${code}`);
}

function joinRoom() {
  if (state.joining) {
    return;
  }
  const input = appEl.querySelector('#nick-input');
  const nickname = (input?.value ?? '').trim();
  state.nickDraft = nickname || state.nickDraft;
  if (!nickname) {
    toast('별명을 넣어 주세요.');
    input?.focus();
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast('연결 중이에요. 잠시만 기다려 주세요…');
    return;
  }
  state.joining = true;
  render();
  send({ type: 'player:join', code: state.route.code, nickname });
  // 응답이 늦어도 버튼이 영원히 잠기지 않게 한다
  setTimeout(() => {
    if (state.joining) {
      state.joining = false;
      render();
    }
  }, JOIN_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

preparePendingAuth();
render();
if (needsSocket(state.route)) {
  connect();
}
