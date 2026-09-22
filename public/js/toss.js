/**
 * 윷 던지기 전용 모드 (실물 윷판·말과 함께 쓰는 디지털 윷가락).
 *  - 팀·차례·설정은 이 기기의 localStorage 에만 저장한다. 반마다 기기 1대를 쓰므로 반끼리 자연스럽게 격리된다.
 *  - 서버 통신이 없어 한 번 열어 두면 네트워크가 끊겨도 계속 던질 수 있다.
 */
import { judgeToss, tossSticks, STICK_COUNT } from './toss-rules.js';
import { SoundBox } from './sound.js';

const STORAGE_KEY = 'yut.toss.v1';
const SHAKE_RATTLE_MS = 110;
const ROLL_MS = 900;
const LAND_GAP_MS = 140;
const RESULT_HOLD_MS = 600;
const MO_SHAKE_MS = 700;
const CONFETTI_MS = 4000;
const MEMBER_MAX_LENGTH = 10;
const MEMBERS_MAX = 40;
const TEAM_NAME_MAX_LENGTH = 10;
/** 뒷도(빽도)는 항상 적용한다: ● 표시 막대 하나만 앞면이면 뒤로 한 칸 */
const BACKDO_ENABLED = true;
const MARKED_STICK_INDEX = 0;
const BODY_CLASS = 'toss-mode';

const TEAM_PRESETS = [
  { name: '호랑이팀', emoji: '🐯', color: '#c62828' },
  { name: '토끼팀', emoji: '🐰', color: '#1565c0' },
  { name: '거북이팀', emoji: '🐢', color: '#2e7d32' },
  { name: '용팀', emoji: '🐲', color: '#ef6c00' },
];

const MESSAGES = {
  DO: ['한 칸 살짝~ 🐾', '조심조심 한 걸음!', '작지만 소중한 한 칸 🌱', '도도한 한 칸 💃'],
  GAE: ['두 칸 멍멍 🐶', '두 걸음 폴짝!', '안정적인 두 칸 👍', '개운하게 두 칸!'],
  GEOL: ['세 칸 성큼성큼 🚶', '좋아요, 세 칸!', '씩씩하게 세 칸 💪', '걸음도 가볍게 세 칸 🎈'],
  YUT: ['윷이다! 다시 던져요 ✨', '대단해요, 한 번 더! 🙌', '윷! 친구들 박수! 👏'],
  MO: ['모다 모! 최고의 던지기 🎆', '전설의 다섯 칸! 🌟', '모! 교실이 떠나가요! 📣'],
  BACKDO: ['어라? 한 칸 뒤로~ 🔙', '괜찮아요, 다음에 만회! 💫', '뒷걸음질 한 칸 🦀'],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function teamStyle(color) {
  const safe = esc(color);
  return `style="--team-color:${safe};--team-tint:${safe}14;--team-soft:${safe}55"`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 윷가락 그림 (끝이 뾰족한 타원, 앞면은 X 표시, 뒷면은 진한 나무색, 표시 막대는 붉은 점)
// ---------------------------------------------------------------------------

const STICK_PATH = 'M50 6 C 84 40, 96 150, 96 220 C 96 290, 84 400, 50 434 C 16 400, 4 290, 4 220 C 4 150, 16 40, 50 6 Z';
const MARK_ROWS = [118, 190, 262, 334];
const MARK_HALF = 14;

function stickMarkup(index) {
  const marker =
    index === MARKED_STICK_INDEX ? '<circle cx="50" cy="44" r="17" fill="#f3c9c9" /><circle cx="50" cy="44" r="10" fill="#d32f2f" />' : '';
  const crosses = MARK_ROWS.map(
    (y) => `<path d="M36 ${y - MARK_HALF} L64 ${y + MARK_HALF} M64 ${y - MARK_HALF} L36 ${y + MARK_HALF}" />`,
  ).join('');
  return `
    <div class="yut-stick is-flat" data-stick="${index}">
      <svg class="face front" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-front-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#efe0be" /><stop offset="0.45" stop-color="#f8eed6" /><stop offset="1" stop-color="#e9d7ae" />
          </linearGradient>
        </defs>
        <path d="${STICK_PATH}" fill="url(#yut-front-${index})" stroke="#d9c69c" stroke-width="2" />
        <g stroke="#d8c59a" stroke-width="1.5" opacity="0.7"><path d="M32 50 L30 390" /><path d="M50 30 L50 410" /><path d="M68 50 L70 390" /></g>
        <g stroke="#5b3d26" stroke-width="6" stroke-linecap="round" fill="none">${crosses}</g>
        ${marker}
      </svg>
      <svg class="face back" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-back-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#7a5033" /><stop offset="0.5" stop-color="#4e321f" /><stop offset="1" stop-color="#6b4530" />
          </linearGradient>
        </defs>
        <path d="${STICK_PATH}" fill="url(#yut-back-${index})" stroke="#3e2617" stroke-width="2" />
        <g stroke="rgba(0,0,0,0.22)" stroke-width="3" fill="none">
          <path d="M12 120 Q50 108 88 120" /><path d="M8 200 Q50 190 92 200" /><path d="M8 280 Q50 292 92 280" /><path d="M14 350 Q50 340 86 350" />
        </g>
        ${marker}
      </svg>
    </div>`;
}

// ---------------------------------------------------------------------------
// 상태 저장
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    settings: {
      teamCount: 2,
      sound: true,
      teamNames: [null, null, null, null],
      members: [[], [], [], []],
    },
    turn: { teamIndex: 0, cursors: [0, 0, 0, 0] },
    pendingExtra: false,
    lastThrow: null,
  };
}

function loadState() {
  const base = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') {
      return base;
    }
    return {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings ?? {}) },
      turn: { ...base.turn, ...(saved.turn ?? {}) },
    };
  } catch {
    return base;
  }
}

function saveState(state) {
  try {
    const { settings, turn, pendingExtra, lastThrow } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, turn, pendingExtra, lastThrow }));
  } catch {
    // 저장이 막혀도(사생활 보호 모드 등) 이 화면 안에서는 계속 동작한다
  }
}

function teamsOf(state) {
  return TEAM_PRESETS.slice(0, state.settings.teamCount).map((preset, index) => ({
    index,
    emoji: preset.emoji,
    color: preset.color,
    name: state.settings.teamNames[index] || preset.name,
    members: state.settings.members[index] ?? [],
  }));
}

function currentMember(state, teamIndex) {
  const members = state.settings.members[teamIndex] ?? [];
  if (members.length === 0) {
    return null;
  }
  return members[state.turn.cursors[teamIndex] % members.length];
}

/** "3개 앞면 · 3칸 이동" 같은 결과 설명 */
function describeOutcome(result, flats) {
  if (result.key === 'BACKDO') {
    return '표시 막대만 앞면 · 뒤로 1칸';
  }
  const fronts = flats.filter(Boolean).length;
  return `${fronts}개 앞면 · ${result.steps}칸 이동${result.again ? ' · 한 번 더!' : ''}`;
}

// ---------------------------------------------------------------------------
// 윷 던지기 화면
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container 비어 있는 컨테이너. 이 함수가 내용을 채우고 관리한다.
 * @param {{ onLeave: () => void }} handlers
 * @returns {{ unmount: () => void }}
 */
export function mountTossPage(container, { onLeave }) {
  const state = loadState();
  const sound = new SoundBox(state.settings.sound);
  const previousTitle = document.title;
  document.title = '윷 던지기';
  document.body.classList.add(BODY_CLASS);

  container.innerHTML = `
    <div class="toss-page">
      <div class="toss-toolbar">
        <button class="tbtn" data-t="leave">‹ 시작 화면</button>
        <div class="row">
          <button class="tbtn" data-t="sound" aria-label="효과음"></button>
          <button class="tbtn" data-t="settings">⚙️ 설정</button>
        </div>
      </div>
      <header class="toss-title">
        <h1>🪵 윷 던지기</h1>
        <p>막대가 없어도 여기서 바로 던져 보세요</p>
      </header>
      <section class="toss-turn" data-r="turn"></section>
      <section class="yut-card" data-r="stage">
        <div class="yut-sticks">${Array.from({ length: STICK_COUNT }, (_, i) => stickMarkup(i)).join('')}</div>
        <p class="yut-caption"><span class="dot"></span> 표시가 있는 막대만 앞면이면 뒷도(빽도)예요</p>
        <button class="throw-btn" data-t="throw">윷 던지기</button>
        <div class="toss-outcome">
          <div class="outcome-name" data-r="result"></div>
          <div class="outcome-sub" data-r="sub">버튼을 꾹 눌러 흔들다가 놓으면 던져요</div>
          <div class="outcome-msg" data-r="message"></div>
        </div>
      </section>
      <div class="toss-secondary">
        <button class="tbtn" data-t="caught">😈 잡았다! 한 번 더</button>
        <button class="tbtn" data-t="skip">⏭ 차례 넘기기</button>
      </div>
      <div class="modal hidden" data-r="settings"></div>
    </div>`;

  const els = {
    turn: container.querySelector('[data-r="turn"]'),
    stage: container.querySelector('[data-r="stage"]'),
    sticks: [...container.querySelectorAll('.yut-stick')],
    result: container.querySelector('[data-r="result"]'),
    sub: container.querySelector('[data-r="sub"]'),
    message: container.querySelector('[data-r="message"]'),
    throwBtn: container.querySelector('[data-t="throw"]'),
    caughtBtn: container.querySelector('[data-t="caught"]'),
    soundBtn: container.querySelector('[data-t="sound"]'),
    settings: container.querySelector('[data-r="settings"]'),
  };

  let busy = false;
  let shaking = false;
  let rattleTimer = null;
  let settingsDraft = null;

  // ---- 렌더링 ------------------------------------------------------------

  function renderTurn() {
    const teams = teamsOf(state);
    const team = teams[state.turn.teamIndex] ?? teams[0];
    const member = currentMember(state, team.index);
    els.turn.innerHTML = `
      <div class="team-chips">
        ${teams
          .map(
            (t) => `
          <button class="team-chip ${t.index === team.index ? 'active' : ''}" ${teamStyle(t.color)} data-t="team" data-i="${t.index}">
            ${t.emoji} ${esc(t.name)}${t.index === team.index && state.pendingExtra ? '<span class="badge">한 번 더!</span>' : ''}
          </button>`,
          )
          .join('')}
      </div>
      <p class="turn-hint">지금 던질 팀 · <b ${teamStyle(team.color)}>${team.emoji} ${esc(team.name)}</b>${member ? ` · <b>${esc(member)}</b> 친구` : ''}</p>`;
    els.caughtBtn.disabled = !(state.lastThrow && state.lastThrow.advanced);
  }

  function renderSound() {
    els.soundBtn.textContent = state.settings.sound ? '🔊 소리 켬' : '🔇 소리 끔';
  }

  function renderAll() {
    renderTurn();
    renderSound();
  }

  function resetStickFaces() {
    for (const stick of els.sticks) {
      stick.classList.remove('is-round', 'landed');
      stick.classList.add('is-flat');
    }
  }

  // ---- 차례 -----------------------------------------------------------------

  function advanceTurn() {
    const teamIndex = state.turn.teamIndex;
    state.turn.cursors[teamIndex] = (state.turn.cursors[teamIndex] ?? 0) + 1;
    state.turn.teamIndex = (teamIndex + 1) % state.settings.teamCount;
    state.pendingExtra = false;
  }

  function applyResult(result, flats) {
    const teamIndex = state.turn.teamIndex;
    state.lastThrow = { teamIndex, member: currentMember(state, teamIndex), key: result.key, flats, at: Date.now(), advanced: false };
    if (result.again) {
      state.pendingExtra = true;
    } else {
      advanceTurn();
      state.lastThrow.advanced = true;
    }
  }

  /** 실물 윷판에서 상대 말을 잡았을 때: 방금 던진 팀에게 차례를 되돌려 준다 */
  function grantCaughtExtra() {
    const last = state.lastThrow;
    if (!last || !last.advanced) {
      return;
    }
    state.turn.teamIndex = last.teamIndex;
    state.turn.cursors[last.teamIndex] = Math.max(0, state.turn.cursors[last.teamIndex] - 1);
    state.pendingExtra = true;
    last.advanced = false;
    sound.tick();
    renderTurn();
    saveState(state);
  }

  // ---- 던지기 ---------------------------------------------------------------

  function startShake() {
    if (busy || shaking) {
      return;
    }
    shaking = true;
    sound.unlock();
    els.stage.classList.add('shaking');
    els.throwBtn.classList.add('pressed');
    els.sub.textContent = '흔들흔들… 놓으면 던져요';
    rattleTimer = setInterval(() => sound.rattle(), SHAKE_RATTLE_MS);
    sound.rattle();
  }

  function stopShake() {
    shaking = false;
    clearInterval(rattleTimer);
    rattleTimer = null;
    els.stage.classList.remove('shaking');
    els.throwBtn.classList.remove('pressed');
  }

  async function throwSticks() {
    if (busy) {
      return;
    }
    busy = true;
    els.throwBtn.disabled = true;
    sound.unlock();
    const flats = tossSticks();
    const result = judgeToss(flats, BACKDO_ENABLED);
    const team = teamsOf(state)[state.turn.teamIndex];

    els.result.textContent = '';
    els.result.classList.remove('pop');
    els.sub.textContent = '';
    els.message.textContent = '';
    resetStickFaces();
    els.stage.classList.add('rolling');
    sound.whoosh();
    await sleep(ROLL_MS);
    els.stage.classList.remove('rolling');

    for (let i = 0; i < els.sticks.length; i += 1) {
      els.sticks[i].classList.remove('is-flat', 'is-round');
      els.sticks[i].classList.add(flats[i] ? 'is-flat' : 'is-round', 'landed');
      sound.clack();
      await sleep(LAND_GAP_MS);
    }
    await sleep(200);

    els.result.textContent = result.name;
    els.result.style.color = team.color;
    els.result.classList.add('pop');
    els.sub.textContent = describeOutcome(result, flats);
    els.message.textContent = `${team.emoji} ${pick(MESSAGES[result.key])}`;
    sound.result(result.key);
    if (result.again) {
      launchConfetti(result.key === 'MO' ? 70 : 36, teamsOf(state).map((t) => t.color));
    }
    if (result.key === 'MO') {
      document.body.classList.add('mo-shake');
      setTimeout(() => document.body.classList.remove('mo-shake'), MO_SHAKE_MS);
    }

    applyResult(result, flats);
    renderTurn();
    saveState(state);

    await sleep(RESULT_HOLD_MS);
    busy = false;
    els.throwBtn.disabled = false;
  }

  function launchConfetti(count, colors) {
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'confetti';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 0.8}s`;
      piece.style.animationDuration = `${2.4 + Math.random() * 1.6}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.append(piece);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), CONFETTI_MS);
  }

  // ---- 설정 -------------------------------------------------------------------

  function openSettings() {
    settingsDraft = JSON.parse(JSON.stringify(state.settings));
    renderSettings();
    els.settings.classList.remove('hidden');
  }

  function closeSettings() {
    settingsDraft = null;
    els.settings.classList.add('hidden');
  }

  function renderSettings() {
    const draft = settingsDraft;
    const seg = (name, options, current) =>
      `<div class="seg" data-s="${name}">${options.map((o) => `<button class="${o.value === current ? 'active' : ''}" data-value="${o.value}">${o.label}</button>`).join('')}</div>`;
    els.settings.innerHTML = `
      <div class="modal-card">
        <h2 style="margin:0 0 10px">⚙️ 설정</h2>
        <div class="setting-row"><div class="label">팀 수</div>${seg('teamCount', [2, 3, 4].map((v) => ({ value: v, label: v })), draft.teamCount)}</div>
        ${TEAM_PRESETS.slice(0, draft.teamCount)
          .map(
            (preset, i) => `
          <div class="team-setting" ${teamStyle(preset.color)}>
            <div class="row">
              <span style="font-size:1.6rem">${preset.emoji}</span>
              <input class="input grow" data-s="teamName" data-i="${i}" maxlength="${TEAM_NAME_MAX_LENGTH}" placeholder="${preset.name}" value="${esc(draft.teamNames[i] ?? '')}" />
            </div>
            <textarea data-s="members" data-i="${i}" placeholder="던질 친구 이름을 쉼표(,)나 줄바꿈으로 나눠 적어요 (안 적어도 돼요)">${esc((draft.members[i] ?? []).join(', '))}</textarea>
          </div>`,
          )
          .join('')}
        <div class="setting-row"><div class="label">뒷도(빽도)<small>● 표시 막대만 앞면이면 뒤로 1칸</small></div><span class="chip">항상 켜짐</span></div>
        <div class="setting-row"><div class="label">효과음</div>${seg('sound', [{ value: false, label: '끄기' }, { value: true, label: '켜기' }], draft.sound)}</div>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-primary grow" data-t="settings-save">저장</button>
          <button class="btn" data-t="settings-close">닫기</button>
        </div>
        <p class="center" style="margin:12px 0 0"><button class="btn btn-ghost btn-sm" data-t="reset">↩ 차례를 처음 팀부터 다시</button></p>
      </div>`;
  }

  function saveSettings() {
    const draft = settingsDraft;
    draft.teamNames = draft.teamNames.map((name) => (name ? String(name).trim().slice(0, TEAM_NAME_MAX_LENGTH) : null) || null);
    draft.members = draft.members.map((list) =>
      (Array.isArray(list) ? list : [])
        .map((name) => String(name).trim().slice(0, MEMBER_MAX_LENGTH))
        .filter(Boolean)
        .slice(0, MEMBERS_MAX),
    );
    state.settings = draft;
    if (state.turn.teamIndex >= state.settings.teamCount) {
      state.turn.teamIndex = 0;
      state.pendingExtra = false;
    }
    sound.setEnabled(state.settings.sound);
    closeSettings();
    renderAll();
    saveState(state);
  }

  function resetTurn() {
    const fresh = defaultState();
    state.turn = fresh.turn;
    state.pendingExtra = false;
    state.lastThrow = null;
    els.result.textContent = '';
    els.sub.textContent = '새로 시작해요! 버튼을 꾹 눌러 봐요';
    els.message.textContent = '';
    closeSettings();
    renderAll();
    saveState(state);
  }

  // ---- 이벤트 ---------------------------------------------------------------

  function onPointerDown(event) {
    event.preventDefault();
    startShake();
  }

  function onPointerUp(event) {
    if (!shaking) {
      return;
    }
    event.preventDefault();
    stopShake();
    throwSticks();
  }

  function onKeyDown(event) {
    if (event.target.matches('input, textarea')) {
      return;
    }
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      if (!busy && els.settings.classList.contains('hidden')) {
        throwSticks();
      }
    }
  }

  function onClick(event) {
    const target = event.target.closest('[data-t], .seg[data-s] button');
    if (!target) {
      return;
    }
    if (target.matches('.seg[data-s] button') && settingsDraft) {
      const name = target.closest('.seg').dataset.s;
      const raw = target.dataset.value;
      settingsDraft[name] = name === 'teamCount' ? Number(raw) : raw === 'true';
      renderSettings();
      return;
    }
    switch (target.dataset.t) {
      case 'leave':
        onLeave();
        break;
      case 'sound':
        state.settings.sound = !state.settings.sound;
        sound.setEnabled(state.settings.sound);
        if (state.settings.sound) {
          sound.tick();
        }
        renderSound();
        saveState(state);
        break;
      case 'settings':
        openSettings();
        break;
      case 'settings-close':
        closeSettings();
        break;
      case 'settings-save':
        saveSettings();
        break;
      case 'reset':
        resetTurn();
        break;
      case 'team':
        state.turn.teamIndex = Number(target.dataset.i);
        state.pendingExtra = false;
        sound.tick();
        renderTurn();
        saveState(state);
        break;
      case 'skip':
        advanceTurn();
        if (state.lastThrow) {
          state.lastThrow.advanced = false;
        }
        sound.tick();
        renderTurn();
        saveState(state);
        break;
      case 'caught':
        grantCaughtExtra();
        break;
      default:
        break;
    }
  }

  function onInput(event) {
    if (!settingsDraft) {
      return;
    }
    const target = event.target;
    if (target.dataset.s === 'teamName') {
      settingsDraft.teamNames[Number(target.dataset.i)] = target.value;
    } else if (target.dataset.s === 'members') {
      settingsDraft.members[Number(target.dataset.i)] = target.value.split(/[,\n]/).map((name) => name.trim()).filter(Boolean);
    }
  }

  els.throwBtn.addEventListener('pointerdown', onPointerDown);
  els.throwBtn.addEventListener('pointerup', onPointerUp);
  els.throwBtn.addEventListener('pointercancel', onPointerUp);
  els.throwBtn.addEventListener('pointerleave', onPointerUp);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeyDown);

  renderAll();

  return {
    unmount() {
      stopShake();
      document.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', onInput);
      document.body.classList.remove('mo-shake', BODY_CLASS);
      document.title = previousTitle;
      container.innerHTML = '';
    },
  };
}
