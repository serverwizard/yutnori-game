/**
 * 윷 던지기 전용 모드 (실물 윷판·말과 함께 쓰는 디지털 윷가락).
 *  - 반(classId)마다 차례·설정·오늘의 기록을 이 기기의 localStorage 에 따로 저장한다.
 *    같은 주소를 다른 반이 다른 기기에서 열어도 서로 섞이지 않고, 한 기기를 여러 반이 돌려 써도 반별로 분리된다.
 *  - 서버 통신이 없어 한 번 열어 두면 네트워크가 끊겨도 계속 던질 수 있다.
 */
import { judgeToss, tossSticks, TOSS_RESULTS, STICK_COUNT } from './toss-rules.js';
import { SoundBox } from './sound.js';

const STORAGE_PREFIX = 'yut.toss.v1.';
const HISTORY_LIMIT = 40;
const RECENT_SHOWN = 14;
const SHAKE_RATTLE_MS = 110;
const ROLL_MS = 900;
const LAND_GAP_MS = 140;
const RESULT_HOLD_MS = 700;
const MO_SHAKE_MS = 700;
const CONFETTI_MS = 4000;
const MEMBER_MAX_LENGTH = 10;
const MEMBERS_MAX = 40;
const TEAM_NAME_MAX_LENGTH = 10;
const CLASS_ID_PATTERN = /^[A-Za-z0-9가-힣_-]{1,20}$/;
const RESULT_ORDER = ['DO', 'GAE', 'GEOL', 'YUT', 'MO', 'BACKDO'];

const TEAM_PRESETS = [
  { name: '호랑이팀', emoji: '🐯', color: '#ff6b6b' },
  { name: '토끼팀', emoji: '🐰', color: '#4dabf7' },
  { name: '거북이팀', emoji: '🐢', color: '#51cf66' },
  { name: '용팀', emoji: '🐲', color: '#fcc419' },
];

const MESSAGES = {
  DO: ['한 칸 살짝~ 🐾', '조심조심 한 걸음!', '작지만 소중한 한 칸 🌱', '도도한 한 칸 💃'],
  GAE: ['두 칸 멍멍 🐶', '두 걸음 폴짝!', '안정적인 두 칸 👍', '개운하게 두 칸!'],
  GEOL: ['세 칸 성큼성큼 🚶', '좋아요, 세 칸!', '씩씩하게 세 칸 💪', '걸음도 가볍게 세 칸 🎈'],
  YUT: ['네 칸 + 한 번 더! 🎉', '윷이다! 다시 던져요 ✨', '대단해요, 한 번 더! 🙌', '윷! 친구들 박수! 👏'],
  MO: ['다섯 칸 + 한 번 더! 🏆', '모다 모! 최고의 던지기 🎆', '전설의 다섯 칸! 🌟', '모! 교실이 떠나가요! 📣'],
  BACKDO: ['뒤로 한 칸 🙈', '어라? 한 칸 뒤로~ 🔙', '괜찬아요, 다음에 만회! 💫', '뒷걸음질 한 칸 🦀'],
};

export function isValidClassId(classId) {
  return CLASS_ID_PATTERN.test(String(classId ?? ''));
}

/** "3-1" → "3학년 1반", 그 외는 그대로 */
export function classLabel(classId) {
  const match = String(classId).match(/^(\d{1,2})-(\d{1,2})$/);
  return match ? `${match[1]}학년 ${match[2]}반` : String(classId);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function teamStyle(color) {
  const safe = esc(color);
  return `style="--team-color:${safe};--team-tint:${safe}1a;--team-soft:${safe}66"`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 반 고르기
// ---------------------------------------------------------------------------

const DEFAULT_CLASS_COUNT = 10;
const GRADES = [1, 2, 3, 4, 5, 6];

export function renderClassPicker(grade) {
  return `
    <div class="landing">
      <p class="hero">🥢</p>
      <h1 class="title">우리 반을 골라요<small>반마다 차례와 오늘의 기록이 따로 저장돼요</small></h1>
      <section class="card">
        <div class="setting-row">
          <div class="label">학년</div>
          <div class="seg">${GRADES.map((g) => `<button class="${g === grade ? 'active' : ''}" data-action="pick-grade" data-grade="${g}">${g}</button>`).join('')}</div>
        </div>
        <h2 style="margin-top:14px">${grade}학년 몇 반인가요?</h2>
        <div class="class-grid">
          ${Array.from({ length: DEFAULT_CLASS_COUNT }, (_, i) => i + 1)
            .map((c) => `<button class="btn" data-action="pick-class" data-class="${grade}-${c}">${c}반</button>`)
            .join('')}
        </div>
        <div class="row" style="margin-top:14px">
          <input class="input grow" id="class-input" maxlength="20" placeholder="직접 입력 (예: 3-11, 별빛반)" autocomplete="off" />
          <button class="btn btn-secondary" data-action="pick-class-custom">열기</button>
        </div>
        <p class="muted" style="margin-top:10px">한글·영문·숫자·하이픈(-)으로 20자까지 쓸 수 있어요.</p>
      </section>
      <p class="center"><button class="btn btn-ghost" data-action="go-home">시작 화면으로</button></p>
    </div>`;
}

// ---------------------------------------------------------------------------
// 상태 저장
// ---------------------------------------------------------------------------

function emptyStats() {
  return Object.fromEntries(RESULT_ORDER.map((key) => [key, 0]));
}

function defaultState(classId) {
  return {
    classId,
    settings: {
      teamCount: 2,
      backdo: false,
      sound: true,
      teamNames: [null, null, null, null],
      members: [[], [], [], []],
    },
    turn: { teamIndex: 0, cursors: [0, 0, 0, 0] },
    pendingExtra: false,
    lastThrow: null,
    history: [],
    stats: emptyStats(),
    teamLuck: [0, 0, 0, 0],
  };
}

function loadState(classId) {
  const base = defaultState(classId);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + classId) ?? 'null');
    if (!saved || typeof saved !== 'object') {
      return base;
    }
    return {
      ...base,
      ...saved,
      classId,
      settings: { ...base.settings, ...(saved.settings ?? {}) },
      turn: { ...base.turn, ...(saved.turn ?? {}) },
      stats: { ...base.stats, ...(saved.stats ?? {}) },
      history: Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_LIMIT) : [],
      teamLuck: Array.isArray(saved.teamLuck) && saved.teamLuck.length === 4 ? saved.teamLuck : base.teamLuck,
    };
  } catch {
    return base;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_PREFIX + state.classId, JSON.stringify(state));
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

// ---------------------------------------------------------------------------
// 윷 던지기 화면
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container 비어 있는 컨테이너. 이 함수가 내용을 채우고 관리한다.
 * @param {string} classId
 * @param {{ onLeave: () => void }} handlers
 * @returns {{ classId: string, unmount: () => void }}
 */
export function mountTossPage(container, classId, { onLeave }) {
  const state = loadState(classId);
  const sound = new SoundBox(state.settings.sound);
  const label = classLabel(classId);
  const previousTitle = document.title;
  document.title = `${label} 윷 던지기`;

  container.innerHTML = `
    <div class="toss-page">
      <header class="toss-header">
        <button class="btn btn-ghost btn-sm" data-t="leave">‹ 반 바꾸기</button>
        <h1>🥢 ${esc(label)} 윷 던지기</h1>
        <div class="row">
          <button class="btn btn-sm" data-t="sound" aria-label="효과음"></button>
          <button class="btn btn-sm" data-t="settings">⚙️ 설정</button>
        </div>
      </header>
      <section class="toss-turn" data-r="turn"></section>
      <section class="toss-stage" data-r="stage">
        <div class="sticks">${Array.from({ length: STICK_COUNT }, () => '<div class="stick"><span class="stick-face"></span></div>').join('')}</div>
        <div class="toss-result-big" data-r="result"></div>
        <div class="toss-message" data-r="message">윷가락을 꾹 눌러서 흔들어 봐요!</div>
      </section>
      <section class="toss-actions">
        <button class="btn hold-btn" data-t="throw">🥢 꾹 눌러 흔들고, 놓으면 던져요!</button>
        <div class="row" style="justify-content:center">
          <button class="btn btn-sm" data-t="caught">😈 잡았다! 한 번 더</button>
          <button class="btn btn-sm" data-t="skip">⏭ 차례 넘기기</button>
        </div>
      </section>
      <section class="card toss-board">
        <h2>📊 오늘의 기록</h2>
        <div data-r="stats"></div>
        <div class="history" data-r="history"></div>
      </section>
      <div class="modal hidden" data-r="settings"></div>
    </div>`;

  const els = {
    turn: container.querySelector('[data-r="turn"]'),
    stage: container.querySelector('[data-r="stage"]'),
    sticks: [...container.querySelectorAll('.toss-stage .stick')],
    result: container.querySelector('[data-r="result"]'),
    message: container.querySelector('[data-r="message"]'),
    throwBtn: container.querySelector('[data-t="throw"]'),
    caughtBtn: container.querySelector('[data-t="caught"]'),
    soundBtn: container.querySelector('[data-t="sound"]'),
    stats: container.querySelector('[data-r="stats"]'),
    history: container.querySelector('[data-r="history"]'),
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
            (t) =>
              `<button class="team-chip ${t.index === team.index ? 'active' : ''}" ${teamStyle(t.color)} data-t="team" data-i="${t.index}">${t.emoji} ${esc(t.name)}</button>`,
          )
          .join('')}
      </div>
      <div class="now-throwing" ${teamStyle(team.color)}>
        <span class="muted-light">지금 던질 팀</span>
        <b>${team.emoji} ${esc(team.name)}</b>
        ${member ? `<span class="member">· <b>${esc(member)}</b> 친구</span>` : ''}
        ${state.pendingExtra ? '<span class="badge">한 번 더!</span>' : ''}
      </div>`;
    els.result.style.setProperty('--team-color', team.color);
    els.caughtBtn.disabled = !(state.lastThrow && state.lastThrow.advanced);
  }

  function renderStats() {
    const total = RESULT_ORDER.reduce((sum, key) => sum + (state.stats[key] ?? 0), 0);
    const max = Math.max(1, ...RESULT_ORDER.map((key) => state.stats[key] ?? 0));
    const keys = RESULT_ORDER.filter((key) => key !== 'BACKDO' || state.settings.backdo || state.stats.BACKDO > 0);
    const teams = teamsOf(state);
    const luckiest = teams.reduce((best, t) => (state.teamLuck[t.index] > (best ? state.teamLuck[best.index] : 0) ? t : best), null);
    els.stats.innerHTML = `
      <div class="stat-row">
        ${keys
          .map((key) => {
            const count = state.stats[key] ?? 0;
            return `<div class="stat"><div class="stat-name">${TOSS_RESULTS[key].name}</div><div class="stat-bar"><i style="width:${Math.round((count / max) * 100)}%"></i></div><div class="stat-count">${count}</div></div>`;
          })
          .join('')}
      </div>
      <p class="muted" style="margin:10px 0 0">
        모두 <b>${total}</b>번 던졌어요${luckiest ? ` · 행운의 팀 ${luckiest.emoji} ${esc(luckiest.name)} (윷·모 ${state.teamLuck[luckiest.index]}번)` : ''}
      </p>`;
    els.history.innerHTML = state.history
      .slice(0, RECENT_SHOWN)
      .map((entry) => {
        const team = teams[entry.teamIndex] ?? teams[0];
        return `<span class="chip" ${teamStyle(team.color)}>${team.emoji} ${TOSS_RESULTS[entry.key]?.name ?? '?'}</span>`;
      })
      .join('');
  }

  function renderSound() {
    els.soundBtn.textContent = state.settings.sound ? '🔊 소리 켬' : '🔇 소리 끔';
  }

  function renderAll() {
    renderTurn();
    renderStats();
    renderSound();
    resetSticks();
  }

  function resetSticks() {
    for (const stick of els.sticks) {
      stick.className = 'stick';
    }
    if (state.settings.backdo) {
      els.sticks[0].classList.add('marked');
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
    state.history.unshift({ teamIndex, key: result.key, at: Date.now() });
    state.history.length = Math.min(state.history.length, HISTORY_LIMIT);
    state.stats[result.key] = (state.stats[result.key] ?? 0) + 1;
    if (result.again) {
      state.teamLuck[teamIndex] += 1;
    }
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
    els.message.textContent = '흔들흔들… 놓으면 던져요!';
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
    const result = judgeToss(flats, state.settings.backdo);
    const team = teamsOf(state)[state.turn.teamIndex];

    els.result.textContent = '';
    els.result.classList.remove('pop');
    els.message.textContent = '';
    resetSticks();
    els.stage.classList.add('rolling');
    sound.whoosh();
    await sleep(ROLL_MS);
    els.stage.classList.remove('rolling');

    for (let i = 0; i < els.sticks.length; i += 1) {
      els.sticks[i].classList.add(flats[i] ? 'flat' : 'round', 'landed');
      sound.clack();
      await sleep(LAND_GAP_MS);
    }
    await sleep(200);

    els.result.textContent = `${result.name}!`;
    els.result.classList.add('pop');
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
    renderStats();
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
        <h2 style="margin:0 0 10px">⚙️ ${esc(label)} 설정</h2>
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
        <div class="setting-row"><div class="label">뒷도(백도)<small>★ 가락 하나만 배가 위면 뒤로 1칸</small></div>${seg('backdo', [{ value: false, label: '끄기' }, { value: true, label: '켜기' }], draft.backdo)}</div>
        <div class="setting-row"><div class="label">효과음</div>${seg('sound', [{ value: false, label: '끄기' }, { value: true, label: '켜기' }], draft.sound)}</div>
        <div class="setting-row">
          <div class="label">이 반 주소<small>다른 기기에서 열 때 찍어요</small></div>
          <img class="mini-qr" src="/qr/toss/${encodeURIComponent(classId)}.svg" alt="이 반 주소 QR" />
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-primary grow" data-t="settings-save">저장</button>
          <button class="btn" data-t="settings-close">닫기</button>
        </div>
        <p class="center" style="margin:12px 0 0"><button class="btn btn-ghost btn-sm" data-t="reset">🧹 오늘의 기록·차례 지우기</button></p>
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

  function resetRecords() {
    if (!window.confirm(`${label}의 오늘 기록과 차례를 모두 지울까요?`)) {
      return;
    }
    const fresh = defaultState(classId);
    state.turn = fresh.turn;
    state.pendingExtra = false;
    state.lastThrow = null;
    state.history = [];
    state.stats = emptyStats();
    state.teamLuck = [0, 0, 0, 0];
    els.result.textContent = '';
    els.message.textContent = '새로 시작해요! 윷가락을 꾹 눌러 봐요.';
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
        resetRecords();
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
    classId,
    unmount() {
      stopShake();
      document.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', onInput);
      document.body.classList.remove('mo-shake');
      document.title = previousTitle;
      container.innerHTML = '';
    },
  };
}
