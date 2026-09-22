/**
 * 윷 던지기 전용 모드 (실물 윷판·말과 함께 쓰는 디지털 윷가락).
 *  - 서버 통신도, 저장하는 값도 없다. 한 번 열어 두면 네트워크가 끊겨도 계속 던질 수 있다.
 */
import { judgeToss, tossSticks, STICK_COUNT } from './toss-rules.js';

const ROLL_MS = 900;
const LAND_GAP_MS = 140;
const RESULT_HOLD_MS = 600;
const MO_SHAKE_MS = 700;
const CONFETTI_MS = 4000;
/** 빽도는 항상 적용한다: ● 표시 막대 하나만 앞면이면 뒤로 한 칸 */
const BACKDO_ENABLED = true;
const MARKED_STICK_INDEX = 0;
const BODY_CLASS = 'toss-mode';
const CONFETTI_COLORS = ['#c62828', '#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a'];

const MESSAGES = {
  DO: ['한 칸 살짝~ 🐾', '조심조심 한 걸음!', '작지만 소중한 한 칸 🌱', '도도한 한 칸 💃'],
  GAE: ['두 칸 멍멍 🐶', '두 걸음 폴짝!', '안정적인 두 칸 👍', '개운하게 두 칸!'],
  GEOL: ['세 칸 성큼성큼 🚶', '좋아요, 세 칸!', '씩씩하게 세 칸 💪', '걸음도 가볍게 세 칸 🎈'],
  YUT: ['윷이다! 다시 던져요 ✨', '대단해요, 한 번 더! 🙌', '윷! 친구들 박수! 👏'],
  MO: ['모다 모! 최고의 던지기 🎆', '전설의 다섯 칸! 🌟', '모! 교실이 떠나가요! 📣'],
  BACKDO: ['어라? 한 칸 뒤로~ 🔙', '괜찮아요, 다음에 만회! 💫', '뒷걸음질 한 칸 🦀'],
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 윷가락 그림: 통나무를 반으로 쪼갠 반원통형 막대 (삽화 느낌의 굵은 외곽선)
//  - 앞면(배): 평평한 연한 크림색 단면
//  - 뒷면(등): 둥근 황갈색 껍질 쪽, X 표시 3개, 아래 끝에 반원 단면이 살짝 보인다
// ---------------------------------------------------------------------------

/** 위아래가 살짝 둥근 막대 몸통 (viewBox 0 0 100 440) */
const STICK_BODY = 'M16 10 H84 Q94 10 94 20 V418 Q94 430 84 430 H16 Q6 430 6 418 V20 Q6 10 16 10 Z';
const OUTLINE_COLOR = '#4b311a';
const OUTLINE_WIDTH = 4;
const MARK_ROWS = [130, 220, 310];
const MARK_HALF = 15;

function stickMarkup(index) {
  const marker =
    index === MARKED_STICK_INDEX ? '<circle cx="50" cy="52" r="16" fill="#f3c9c9" /><circle cx="50" cy="52" r="9" fill="#d32f2f" />' : '';
  const crosses = MARK_ROWS.map(
    (y) => `<path d="M${50 - MARK_HALF} ${y - MARK_HALF} L${50 + MARK_HALF} ${y + MARK_HALF} M${50 + MARK_HALF} ${y - MARK_HALF} L${50 - MARK_HALF} ${y + MARK_HALF}" />`,
  ).join('');
  return `
    <div class="yut-stick is-flat" data-stick="${index}">
      <svg class="face front" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-front-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#e6d6ae" /><stop offset="0.5" stop-color="#f4eacf" /><stop offset="1" stop-color="#e2d0a6" />
          </linearGradient>
        </defs>
        <path d="${STICK_BODY}" fill="url(#yut-front-${index})" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round" />
        <g stroke="#cdb98a" stroke-width="2" stroke-linecap="round" opacity="0.8">
          <path d="M30 60 Q28 220 31 380" /><path d="M50 40 Q53 220 49 400" /><path d="M70 70 Q72 220 69 370" />
        </g>
        ${marker}
      </svg>
      <svg class="face back" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-back-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#a47a4d" /><stop offset="0.35" stop-color="#cba175" /><stop offset="0.55" stop-color="#d6b088" />
            <stop offset="0.8" stop-color="#b98c5c" /><stop offset="1" stop-color="#93693f" />
          </linearGradient>
          <clipPath id="yut-clip-${index}"><path d="${STICK_BODY}" /></clipPath>
        </defs>
        <path d="${STICK_BODY}" fill="url(#yut-back-${index})" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round" />
        <g clip-path="url(#yut-clip-${index})">
          <path d="M8 10 V430" stroke="rgba(60,35,12,0.18)" stroke-width="10" />
          <path d="M92 10 V430" stroke="rgba(60,35,12,0.22)" stroke-width="10" />
          <path d="M40 30 Q44 220 38 410" stroke="rgba(255,240,210,0.28)" stroke-width="6" stroke-linecap="round" fill="none" />
          <!-- 아래 끝에 살짝 보이는 반원 단면 -->
          <path d="M6 404 Q50 440 94 404 V430 H6 Z" fill="#efe2bf" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" />
        </g>
        <g stroke="#5a3a1c" stroke-width="7" stroke-linecap="round" fill="none">${crosses}</g>
        ${marker}
      </svg>
    </div>`;
}

/** "3개 앞면 · 3칸 이동" 같은 결과 설명 */
function describeOutcome(result, flats) {
  if (result.key === 'BACKDO') {
    return '표시 막대만 뒤집힘 · 뒤로 1칸';
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
  const previousTitle = document.title;
  document.title = '윷 던지기';
  document.body.classList.add(BODY_CLASS);

  container.innerHTML = `
    <div class="toss-page">
      <div class="toss-toolbar">
        <button class="tbtn" data-t="leave">‹ 시작 화면</button>
      </div>
      <header class="toss-title">
        <h1>🪵 윷 던지기</h1>
        <p>막대가 없어도 여기서 바로 던져 보세요</p>
      </header>
      <section class="yut-card" data-r="stage">
        <div class="yut-sticks">${Array.from({ length: STICK_COUNT }, (_, i) => stickMarkup(i)).join('')}</div>
        <p class="yut-caption"><span class="dot"></span> 표시가 있는 막대만 뒤집히면 빽도예요</p>
        <button class="throw-btn" data-t="throw">윷 던지기</button>
        <div class="toss-outcome">
          <div class="outcome-name" data-r="result"></div>
          <div class="outcome-sub" data-r="sub"></div>
          <div class="outcome-msg" data-r="message"></div>
        </div>
      </section>
    </div>`;

  const els = {
    stage: container.querySelector('[data-r="stage"]'),
    sticks: [...container.querySelectorAll('.yut-stick')],
    result: container.querySelector('[data-r="result"]'),
    sub: container.querySelector('[data-r="sub"]'),
    message: container.querySelector('[data-r="message"]'),
    throwBtn: container.querySelector('[data-t="throw"]'),
  };

  let busy = false;
  let shaking = false;

  function resetStickFaces() {
    for (const stick of els.sticks) {
      stick.classList.remove('is-round', 'landed');
      stick.classList.add('is-flat');
    }
  }

  // ---- 던지기 ---------------------------------------------------------------

  function startShake() {
    if (busy || shaking) {
      return;
    }
    shaking = true;
    els.stage.classList.add('shaking');
    els.throwBtn.classList.add('pressed');
  }

  function stopShake() {
    shaking = false;
    els.stage.classList.remove('shaking');
    els.throwBtn.classList.remove('pressed');
  }

  async function throwSticks() {
    if (busy) {
      return;
    }
    busy = true;
    els.throwBtn.disabled = true;
    const flats = tossSticks();
    const result = judgeToss(flats, BACKDO_ENABLED);

    els.result.textContent = '';
    els.result.classList.remove('pop');
    els.sub.textContent = '';
    els.message.textContent = '';
    resetStickFaces();
    els.stage.classList.add('rolling');
    await sleep(ROLL_MS);
    els.stage.classList.remove('rolling');

    for (let i = 0; i < els.sticks.length; i += 1) {
      els.sticks[i].classList.remove('is-flat', 'is-round');
      els.sticks[i].classList.add(flats[i] ? 'is-flat' : 'is-round', 'landed');
      await sleep(LAND_GAP_MS);
    }
    await sleep(200);

    els.result.textContent = result.name;
    els.result.classList.add('pop');
    els.sub.textContent = describeOutcome(result, flats);
    els.message.textContent = pick(MESSAGES[result.key]);
    if (result.again) {
      launchConfetti(result.key === 'MO' ? 70 : 36);
    }
    if (result.key === 'MO') {
      document.body.classList.add('mo-shake');
      setTimeout(() => document.body.classList.remove('mo-shake'), MO_SHAKE_MS);
    }

    await sleep(RESULT_HOLD_MS);
    busy = false;
    els.throwBtn.disabled = false;
  }

  function launchConfetti(count) {
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'confetti';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDelay = `${Math.random() * 0.8}s`;
      piece.style.animationDuration = `${2.4 + Math.random() * 1.6}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.append(piece);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), CONFETTI_MS);
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
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      if (!busy) {
        throwSticks();
      }
    }
  }

  function onClick(event) {
    const target = event.target.closest('[data-t]');
    if (!target) {
      return;
    }
    if (target.dataset.t === 'leave') {
      onLeave();
    }
  }

  els.throwBtn.addEventListener('pointerdown', onPointerDown);
  els.throwBtn.addEventListener('pointerup', onPointerUp);
  els.throwBtn.addEventListener('pointercancel', onPointerUp);
  els.throwBtn.addEventListener('pointerleave', onPointerUp);
  container.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);

  return {
    unmount() {
      stopShake();
      document.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('click', onClick);
      document.body.classList.remove('mo-shake', BODY_CLASS);
      document.title = previousTitle;
      container.innerHTML = '';
    },
  };
}
