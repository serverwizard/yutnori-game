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
/** 빽도는 항상 적용한다: ● 표시 막대 하나만 뒤집히면 뒤로 한 칸 */
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
// 윷가락 그림: 통나무를 반으로 쪼갠 막대를 굵은 외곽선의 삽화 느낌으로 그린다
//  - 앞면(등): 둥근 황갈색 껍질 쪽, 손으로 새긴 듯한 X 표시 3개, 아래 끝에 크림색 반원 단면. 던지기 전엔 모두 이 면이 보인다.
//  - 뒤집힌 면(배): 평평한 연한 크림색 단면, 옅은 나뭇결. 던진 뒤 이 면이 위로 온 개수로 도·개·걸·윷·모를 정한다.
//  - 클래스: is-flat = 뒤집힘(크림색 배가 위), is-round = 앞면(X 표시가 위)
// ---------------------------------------------------------------------------

/** 살짝 둥근 막대 몸통 (viewBox 0 0 100 440) */
const STICK_BODY = 'M22 8 H78 Q94 8 94 26 V414 Q94 432 78 432 H22 Q6 432 6 414 V26 Q6 8 22 8 Z';
const OUTLINE_COLOR = '#5b3d22';
const OUTLINE_WIDTH = 4.5;
const MARK_ROWS = [128, 220, 312];
const MARK_HALF = 15;
/** 던져서 떨어진 뒤 막대가 비스듬히 놓이는 최대 각도·거리 */
const TILT_MAX_DEG = 9;
const DRIFT_MAX_PX = 8;

/** 손으로 새긴 느낌이 나도록 X 획을 조금씩 비뚤게 그린다 */
function carvedCross(y, seed) {
  const j = (n) => ((seed * 31 + n * 17) % 7) - 3;
  return (
    `<path d="M${50 - MARK_HALF + j(1)} ${y - MARK_HALF + j(2)} Q ${50 + j(3)} ${y + j(4)} ${50 + MARK_HALF + j(5)} ${y + MARK_HALF + j(6)}" />` +
    `<path d="M${50 + MARK_HALF + j(7)} ${y - MARK_HALF + j(8)} Q ${50 + j(9)} ${y + j(10)} ${50 - MARK_HALF + j(11)} ${y + MARK_HALF + j(12)}" />`
  );
}

function stickMarkup(index) {
  const marker =
    index === MARKED_STICK_INDEX ? '<circle cx="50" cy="52" r="16" fill="#f3c9c9" /><circle cx="50" cy="52" r="9" fill="#d32f2f" />' : '';
  const crosses = MARK_ROWS.map((y, row) => carvedCross(y, index * 3 + row)).join('');
  return `
    <div class="yut-stick is-round" data-stick="${index}">
      <svg class="face front" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-front-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#dfcda3" /><stop offset="0.4" stop-color="#efe3c1" /><stop offset="0.7" stop-color="#e9dbb5" /><stop offset="1" stop-color="#d6c397" />
          </linearGradient>
        </defs>
        <path d="${STICK_BODY}" fill="url(#yut-front-${index})" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round" />
        <g stroke="#c9b487" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.9">
          <path d="M28 70 Q26 220 30 380" /><path d="M46 40 Q50 220 45 405" /><path d="M64 90 Q67 220 63 360" /><path d="M78 60 Q80 200 77 330" />
        </g>
        ${marker}
      </svg>
      <svg class="face back" viewBox="0 0 100 440" aria-hidden="true">
        <defs>
          <linearGradient id="yut-back-${index}" x1="0" x2="1">
            <stop offset="0" stop-color="#a98056" /><stop offset="0.3" stop-color="#cfa97d" /><stop offset="0.5" stop-color="#d9b88d" />
            <stop offset="0.75" stop-color="#b98f61" /><stop offset="1" stop-color="#8f6a44" />
          </linearGradient>
          <clipPath id="yut-clip-${index}"><path d="${STICK_BODY}" /></clipPath>
        </defs>
        <path d="${STICK_BODY}" fill="url(#yut-back-${index})" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round" />
        <g clip-path="url(#yut-clip-${index})">
          <path d="M88 8 V432" stroke="rgba(70,40,15,0.22)" stroke-width="14" />
          <path d="M36 20 Q40 220 34 420" stroke="rgba(255,240,215,0.30)" stroke-width="7" stroke-linecap="round" fill="none" />
          <path d="M6 402 Q50 442 94 402 V432 H6 Z" fill="#eee1bf" stroke="${OUTLINE_COLOR}" stroke-width="${OUTLINE_WIDTH}" />
        </g>
        <g stroke="#5a3a1e" stroke-width="6.5" stroke-linecap="round" fill="none">${crosses}</g>
        ${marker}
      </svg>
    </div>`;
}

/** 떨어진 막대가 그림처럼 조금씩 비스듬히 놓이도록 한다 */
function scatterStick(stick) {
  const tilt = (Math.random() * 2 - 1) * TILT_MAX_DEG;
  const dx = (Math.random() * 2 - 1) * DRIFT_MAX_PX;
  const dy = (Math.random() * 2 - 1) * DRIFT_MAX_PX;
  stick.style.setProperty('--tilt', `${tilt.toFixed(1)}deg`);
  stick.style.setProperty('--dx', `${dx.toFixed(1)}px`);
  stick.style.setProperty('--dy', `${dy.toFixed(1)}px`);
}

function straightenStick(stick) {
  stick.style.setProperty('--tilt', '0deg');
  stick.style.setProperty('--dx', '0px');
  stick.style.setProperty('--dy', '0px');
}

/** "2개 뒤집힘 · 2칸 이동" 같은 결과 설명. flats[i] 가 true 면 그 막대가 뒤집혀(크림색 배가 위로) 있다. */
function describeOutcome(result, flats) {
  if (result.key === 'BACKDO') {
    return '표시 막대만 뒤집힘 · 뒤로 1칸';
  }
  const flipped = flats.filter(Boolean).length;
  const extra = result.again ? ' · 한 번 더!' : '';
  if (flipped === 0) {
    return `모두 앞면 · ${result.steps}칸 이동${extra}`;
  }
  if (flipped === flats.length) {
    return `모두 뒤집힘 · ${result.steps}칸 이동${extra}`;
  }
  return `${flipped}개 뒤집힘 · ${result.steps}칸 이동${extra}`;
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
        <button class="tbtn" data-t="qr">📱 QR 코드</button>
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
      <div class="qr-overlay hidden" data-r="qr">
        <div class="qr-card">
          <h2>📱 카메라로 찍으면 바로 들어와요</h2>
          <img src="/qr/toss.svg" alt="윷 던지기 화면으로 가는 QR 코드" />
          <p class="qr-url" data-r="qr-url"></p>
          <button class="tbtn" data-t="qr-close">닫기</button>
        </div>
      </div>
    </div>`;

  const els = {
    stage: container.querySelector('[data-r="stage"]'),
    sticks: [...container.querySelectorAll('.yut-stick')],
    result: container.querySelector('[data-r="result"]'),
    sub: container.querySelector('[data-r="sub"]'),
    message: container.querySelector('[data-r="message"]'),
    throwBtn: container.querySelector('[data-t="throw"]'),
    qrOverlay: container.querySelector('[data-r="qr"]'),
    qrUrl: container.querySelector('[data-r="qr-url"]'),
  };
  els.qrUrl.textContent = `${location.origin}/toss`;

  let busy = false;
  let shaking = false;

  /** 던지기 전 상태: 모두 앞면(X 표시)이 위로, 똑바로 */
  function resetStickFaces() {
    for (const stick of els.sticks) {
      stick.classList.remove('is-flat', 'landed');
      stick.classList.add('is-round');
      straightenStick(stick);
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
      scatterStick(els.sticks[i]);
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

  function isQrOpen() {
    return !els.qrOverlay.classList.contains('hidden');
  }

  function onKeyDown(event) {
    if (event.code === 'Escape' && isQrOpen()) {
      els.qrOverlay.classList.add('hidden');
      return;
    }
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      if (!busy && !isQrOpen()) {
        throwSticks();
      }
    }
  }

  function onClick(event) {
    if (event.target === els.qrOverlay) {
      els.qrOverlay.classList.add('hidden');
      return;
    }
    const target = event.target.closest('[data-t]');
    if (!target) {
      return;
    }
    switch (target.dataset.t) {
      case 'leave':
        onLeave();
        break;
      case 'qr':
        els.qrOverlay.classList.remove('hidden');
        break;
      case 'qr-close':
        els.qrOverlay.classList.add('hidden');
        break;
      default:
        break;
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
