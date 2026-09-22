/**
 * 윷놀이 규칙 엔진 (순수 함수 모음, 네트워크·저장소 의존 없음)
 *
 * 윷판 노드 번호
 *  - 바깥 둘레: 1~19 (출발점 오른쪽 아래 모서리에서 시계 반대 방향), 20 = 출발점 도착(난다)
 *  - 5 → 중앙(23) → 15 지름길: 21, 22, [23], 24, 25
 *  - 10 → 중앙(23) → 20 지름길: 26, 27, [23], 28, 29
 *  - 말은 (lane, index) 로 위치를 기억한다. 지름길 진입은 "모서리·중앙에 정확히 멈춘 뒤 다음 이동을 시작할 때" 일어난다.
 */

import { judgeToss, tossSticks } from '../public/js/toss-rules.js';

export const FINISH_NODE = 20;
export const CENTER_NODE = 23;

export const LANES = Object.freeze({
  OUTER: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
  SC5: Object.freeze([21, 22, 23, 24, 25, 15, 16, 17, 18, 19, 20]),
  SC10: Object.freeze([26, 27, 23, 28, 29, 20]),
  SCC: Object.freeze([28, 29, 20]),
});

/** 정확히 멈추면 다음 이동에서 지름길로 들어가는 노드 → 갈아탈 lane */
const JUNCTIONS = Object.freeze({ 5: 'SC5', 10: 'SC10', 23: 'SCC' });

/** 백도로 lane 의 첫 칸에서 한 칸 더 물러날 때 돌아가는 위치 */
const LANE_ENTRY = Object.freeze({
  OUTER: null, // 출발 전(대기)으로 돌아간다
  SC5: { lane: 'OUTER', index: 4 }, // 노드 5
  SC10: { lane: 'OUTER', index: 9 }, // 노드 10
  SCC: { lane: 'SC10', index: 2 }, // 노드 23
});

// 윷 던지기 판정은 브라우저(윷 던지기 전용 모드)와 공유한다
export { STICK_COUNT, FLAT_PROBABILITY, TOSS_RESULTS, judgeToss, tossSticks } from '../public/js/toss-rules.js';

export const TEAM_PRESETS = Object.freeze([
  Object.freeze({ name: '호랑이팀', emoji: '🐯', color: '#ff6b6b' }),
  Object.freeze({ name: '토끼팀', emoji: '🐰', color: '#4dabf7' }),
  Object.freeze({ name: '거북이팀', emoji: '🐢', color: '#51cf66' }),
  Object.freeze({ name: '용팀', emoji: '🐲', color: '#fcc419' }),
]);

export const SETTINGS_LIMITS = Object.freeze({
  teamCount: { min: 2, max: 4, default: 2 },
  piecesPerTeam: { min: 1, max: 4, default: 2 },
});

export function normalizeSettings(raw = {}) {
  const clamp = (value, { min, max, default: fallback }) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  };
  return {
    teamCount: clamp(raw.teamCount, SETTINGS_LIMITS.teamCount),
    piecesPerTeam: clamp(raw.piecesPerTeam, SETTINGS_LIMITS.piecesPerTeam),
    backdo: Boolean(raw.backdo),
  };
}

// ---------------------------------------------------------------------------
// 말 위치 계산
// ---------------------------------------------------------------------------

export function newPiece(id) {
  return { id, lane: 'OUTER', index: -1, done: false };
}

export function isWaiting(piece) {
  return !piece.done && piece.index < 0;
}

export function isOnBoard(piece) {
  return !piece.done && piece.index >= 0;
}

export function nodeOf(piece) {
  if (!isOnBoard(piece)) {
    return null;
  }
  return LANES[piece.lane][piece.index];
}

/**
 * 말을 steps 만큼 움직였을 때의 결과 위치.
 * @returns {{done: true} | {done: false, lane: string, index: number, node: number} | null} 움직일 수 없으면 null
 */
export function computeDestination(piece, steps) {
  if (piece.done) {
    return null;
  }
  if (steps < 0) {
    return computeBackward(piece);
  }
  let { lane, index } = piece;
  if (index >= 0) {
    const junctionLane = JUNCTIONS[LANES[lane][index]];
    if (junctionLane) {
      lane = junctionLane;
      index = -1;
    }
  }
  const nextIndex = index + steps;
  const finishIndex = LANES[lane].length - 1;
  if (nextIndex >= finishIndex) {
    return { done: true };
  }
  return { done: false, lane, index: nextIndex, node: LANES[lane][nextIndex] };
}

function computeBackward(piece) {
  if (piece.index < 0) {
    return null;
  }
  if (piece.index > 0) {
    const index = piece.index - 1;
    return { done: false, lane: piece.lane, index, node: LANES[piece.lane][index] };
  }
  const entry = LANE_ENTRY[piece.lane];
  if (!entry) {
    return { done: false, lane: 'OUTER', index: -1, node: null };
  }
  return { done: false, lane: entry.lane, index: entry.index, node: LANES[entry.lane][entry.index] };
}

// ---------------------------------------------------------------------------
// 게임 상태
// ---------------------------------------------------------------------------

export function createGame(settings) {
  const normalized = normalizeSettings(settings);
  const teams = Array.from({ length: normalized.teamCount }, (_, teamIndex) => ({
    index: teamIndex,
    ...TEAM_PRESETS[teamIndex],
    pieces: Array.from({ length: normalized.piecesPerTeam }, (_, pieceIndex) => newPiece(`${teamIndex}-${pieceIndex}`)),
  }));
  return {
    status: 'LOBBY',
    settings: normalized,
    teams,
    turn: null,
    winnerTeamIndex: null,
    lastToss: null,
    log: [],
  };
}

/**
 * @param {number} firstTeamIndex 먼저 던질 팀. 매 판 바꿔 주면 공평하다.
 */
export function startGame(game, firstTeamIndex = 0) {
  const first = ((firstTeamIndex % game.teams.length) + game.teams.length) % game.teams.length;
  game.status = 'PLAYING';
  game.winnerTeamIndex = null;
  game.lastToss = null;
  game.log = [];
  for (const team of game.teams) {
    team.pieces = team.pieces.map((piece) => newPiece(piece.id));
  }
  game.turn = { teamIndex: first, phase: 'TOSS', pendingToss: null, options: [] };
  pushLog(game, `게임 시작! ${teamLabel(game.teams[first])} 먼저 던져요.`);
  return game;
}

export function teamLabel(team) {
  return `${team.emoji} ${team.name}`;
}

/**
 * 선택 가능한 이동 목록. 같은 칸에 업힌 말은 하나의 선택지로 묶는다.
 * @returns {Array<{kind: 'new'|'piece', node: number|null, pieceIds: string[], dest: object}>}
 */
export function listMoveOptions(team, steps) {
  const options = [];
  const waiting = team.pieces.filter(isWaiting);
  if (waiting.length > 0 && steps > 0) {
    const dest = computeDestination(waiting[0], steps);
    options.push({ kind: 'new', node: null, pieceIds: [waiting[0].id], dest });
  }
  const seenNodes = new Set();
  for (const piece of team.pieces.filter(isOnBoard)) {
    const node = nodeOf(piece);
    if (seenNodes.has(node)) {
      continue;
    }
    seenNodes.add(node);
    const group = team.pieces.filter((other) => isOnBoard(other) && nodeOf(other) === node);
    const dest = computeDestination(piece, steps);
    if (dest) {
      options.push({ kind: 'piece', node, pieceIds: group.map((p) => p.id), dest });
    }
  }
  return options;
}

/**
 * 현재 팀이 윷을 던진다.
 * @param {() => number} random
 * @returns {{result: object, flats: boolean[], options: object[], skipped: boolean}}
 */
export function applyToss(game, random = Math.random) {
  assertPhase(game, 'TOSS');
  const flats = tossSticks(random);
  const result = judgeToss(flats, game.settings.backdo);
  const team = currentTeam(game);
  const options = listMoveOptions(team, result.steps);
  game.lastToss = { teamIndex: team.index, result, flats };
  pushLog(game, `${teamLabel(team)} → ${result.name}!`);

  if (options.length === 0) {
    pushLog(game, `움직일 말이 없어서 차례가 넘어가요.`);
    advanceTurn(game);
    return { result, flats, options, skipped: true };
  }
  game.turn.phase = 'MOVE';
  game.turn.pendingToss = result;
  game.turn.options = options;
  return { result, flats, options, skipped: false };
}

/**
 * 선택한 말을 움직인다.
 * @param {{kind: 'new'|'piece', node?: number|null}} choice
 * @returns {{moved: string[], caught: string[], finished: boolean, extraTurn: boolean, won: boolean, from: number|null, to: number|null}}
 */
export function applyMove(game, choice) {
  assertPhase(game, 'MOVE');
  const option = findOption(game.turn.options, choice);
  if (!option) {
    throw new GameError('선택할 수 없는 말이에요.');
  }
  const team = currentTeam(game);
  const toss = game.turn.pendingToss;
  const movingPieces = team.pieces.filter((piece) => option.pieceIds.includes(piece.id));
  const dest = option.dest;
  const outcome = {
    moved: option.pieceIds,
    caught: [],
    finished: false,
    extraTurn: toss.again,
    won: false,
    from: option.node,
    to: dest.done ? FINISH_NODE : dest.node,
  };

  if (dest.done) {
    for (const piece of movingPieces) {
      piece.done = true;
    }
    outcome.finished = true;
    pushLog(game, `${teamLabel(team)} 말 ${movingPieces.length}개가 났어요! 🎉`);
  } else {
    outcome.caught = catchOpponents(game, team, dest.node);
    for (const piece of movingPieces) {
      piece.lane = dest.lane;
      piece.index = dest.index;
    }
    if (outcome.caught.length > 0) {
      outcome.extraTurn = true;
      pushLog(game, `${teamLabel(team)}이(가) 상대 말 ${outcome.caught.length}개를 잡았어요! 한 번 더!`);
    } else if (dest.node !== null && movingPieces.length < team.pieces.filter((p) => nodeOf(p) === dest.node).length) {
      pushLog(game, `${teamLabel(team)} 말이 업혔어요!`);
    }
  }

  if (team.pieces.every((piece) => piece.done)) {
    game.status = 'FINISHED';
    game.winnerTeamIndex = team.index;
    game.turn = null;
    outcome.won = true;
    outcome.extraTurn = false;
    pushLog(game, `${teamLabel(team)} 승리! 🏆`);
    return outcome;
  }

  if (outcome.extraTurn) {
    game.turn.phase = 'TOSS';
    game.turn.pendingToss = null;
    game.turn.options = [];
    if (toss.again && outcome.caught.length === 0) {
      pushLog(game, `${toss.name}! 한 번 더 던져요.`);
    }
  } else {
    advanceTurn(game);
  }
  return outcome;
}

function catchOpponents(game, team, node) {
  if (node === null) {
    return [];
  }
  const caught = [];
  for (const other of game.teams) {
    if (other.index === team.index) {
      continue;
    }
    for (const piece of other.pieces) {
      if (isOnBoard(piece) && nodeOf(piece) === node) {
        piece.lane = 'OUTER';
        piece.index = -1;
        caught.push(piece.id);
      }
    }
  }
  return caught;
}

function findOption(options, choice) {
  if (!choice || typeof choice !== 'object') {
    return null;
  }
  if (choice.kind === 'new') {
    return options.find((option) => option.kind === 'new') ?? null;
  }
  if (choice.kind === 'piece') {
    return options.find((option) => option.kind === 'piece' && option.node === Number(choice.node)) ?? null;
  }
  return null;
}

/** 강제로 다음 팀에게 차례를 넘긴다 (선생님 스킵). */
export function skipTurn(game) {
  if (game.status !== 'PLAYING') {
    throw new GameError('게임 중이 아니에요.');
  }
  pushLog(game, `${teamLabel(currentTeam(game))} 차례를 건너뛰어요.`);
  advanceTurn(game);
}

function advanceTurn(game) {
  const nextIndex = (game.turn.teamIndex + 1) % game.teams.length;
  game.turn = { teamIndex: nextIndex, phase: 'TOSS', pendingToss: null, options: [] };
}

export function currentTeam(game) {
  return game.teams[game.turn.teamIndex];
}

function assertPhase(game, phase) {
  if (game.status !== 'PLAYING' || !game.turn) {
    throw new GameError('게임 중이 아니에요.');
  }
  if (game.turn.phase !== phase) {
    throw new GameError(phase === 'TOSS' ? '먼저 말을 움직여야 해요.' : '먼저 윷을 던져야 해요.');
  }
}

const LOG_LIMIT = 30;

function pushLog(game, message) {
  game.log.push(message);
  if (game.log.length > LOG_LIMIT) {
    game.log.splice(0, game.log.length - LOG_LIMIT);
  }
}

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}
