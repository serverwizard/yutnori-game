import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMove,
  applyToss,
  computeDestination,
  createGame,
  judgeToss,
  listMoveOptions,
  newPiece,
  nodeOf,
  normalizeSettings,
  startGame,
  TOSS_RESULTS,
} from '../server/game.js';

/** 원하는 배(평평한 면) 패턴이 나오도록 고정된 난수 생성기 */
function fixedFlats(flats) {
  let i = 0;
  return () => (flats[i++ % flats.length] ? 0 : 0.99);
}

function pieceAt(lane, index) {
  return { ...newPiece('t'), lane, index };
}

describe('judgeToss', () => {
  test('배가 0개면 모, 4개면 윷', () => {
    assert.equal(judgeToss([false, false, false, false], false), TOSS_RESULTS.MO);
    assert.equal(judgeToss([true, true, true, true], false), TOSS_RESULTS.YUT);
  });

  test('배 1개는 도, 2개는 개, 3개는 걸', () => {
    assert.equal(judgeToss([false, true, false, false], false), TOSS_RESULTS.DO);
    assert.equal(judgeToss([true, true, false, false], false), TOSS_RESULTS.GAE);
    assert.equal(judgeToss([true, true, true, false], false), TOSS_RESULTS.GEOL);
  });

  test('백도 옵션이 켜져 있고 표시 가락만 배이면 백도', () => {
    assert.equal(judgeToss([true, false, false, false], true), TOSS_RESULTS.BACKDO);
    assert.equal(judgeToss([true, false, false, false], false), TOSS_RESULTS.DO);
    assert.equal(judgeToss([false, true, false, false], true), TOSS_RESULTS.DO);
  });
});

describe('computeDestination', () => {
  test('대기 중인 말은 도로 1번 칸에 들어간다', () => {
    const dest = computeDestination(newPiece('a'), 1);
    assert.deepEqual(dest, { done: false, lane: 'OUTER', index: 0, node: 1 });
  });

  test('바깥길 19번에서 한 칸 이상 가면 난다', () => {
    assert.deepEqual(computeDestination(pieceAt('OUTER', 18), 1), { done: true });
    assert.deepEqual(computeDestination(pieceAt('OUTER', 18), 5), { done: true });
  });

  test('바깥길 18번에서 도는 19번 (아직 나지 않음)', () => {
    assert.equal(computeDestination(pieceAt('OUTER', 17), 1).node, 19);
  });

  test('5번 모서리에 멈춘 말은 다음 이동에서 지름길로 들어간다', () => {
    const dest = computeDestination(pieceAt('OUTER', 4), 1);
    assert.equal(dest.lane, 'SC5');
    assert.equal(dest.node, 21);
  });

  test('5번 모서리를 지나치는 말은 바깥길을 그대로 간다', () => {
    const dest = computeDestination(pieceAt('OUTER', 3), 2);
    assert.equal(dest.lane, 'OUTER');
    assert.equal(dest.node, 6);
  });

  test('5번 지름길은 중앙을 지나 15번 모서리로 이어진다', () => {
    assert.equal(computeDestination(pieceAt('OUTER', 4), 3).node, 23);
    assert.equal(computeDestination(pieceAt('OUTER', 4), 5).node, 25);
    assert.equal(computeDestination(pieceAt('SC5', 4), 1).node, 15);
    assert.equal(computeDestination(pieceAt('SC5', 4), 2).node, 16);
  });

  test('10번 모서리에 멈춘 말은 중앙을 지나 바로 도착한다', () => {
    assert.equal(computeDestination(pieceAt('OUTER', 9), 3).node, 23);
    assert.equal(computeDestination(pieceAt('OUTER', 9), 5).node, 29);
    assert.deepEqual(computeDestination(pieceAt('OUTER', 9), 6), { done: true });
  });

  test('5번 지름길로 중앙에 정확히 멈춘 말은 가장 짧은 길(28, 29)로 나간다', () => {
    const atCenter = pieceAt('SC5', 2);
    assert.equal(computeDestination(atCenter, 1).node, 28);
    assert.deepEqual(computeDestination(atCenter, 3), { done: true });
  });

  test('5번 지름길에서 중앙을 지나치면 24번으로 계속 간다', () => {
    assert.equal(computeDestination(pieceAt('SC5', 1), 2).node, 24);
  });

  test('백도: 바깥길 첫 칸에서는 대기 상태로 돌아간다', () => {
    const dest = computeDestination(pieceAt('OUTER', 0), -1);
    assert.equal(dest.index, -1);
    assert.equal(dest.node, null);
  });

  test('백도: 지름길 첫 칸에서는 진입 모서리로 돌아간다', () => {
    assert.equal(computeDestination(pieceAt('SC5', 0), -1).node, 5);
    assert.equal(computeDestination(pieceAt('SC10', 0), -1).node, 10);
    assert.equal(computeDestination(pieceAt('SCC', 0), -1).node, 23);
  });

  test('백도: 대기 중인 말은 움직일 수 없다', () => {
    assert.equal(computeDestination(newPiece('a'), -1), null);
  });

  test('난 말은 움직일 수 없다', () => {
    assert.equal(computeDestination({ ...newPiece('a'), done: true }, 1), null);
  });
});

describe('listMoveOptions', () => {
  test('대기 말이 여럿이어도 새 말 출발 선택지는 하나', () => {
    const game = createGame({ teamCount: 2, piecesPerTeam: 4 });
    const options = listMoveOptions(game.teams[0], 2);
    assert.equal(options.length, 1);
    assert.equal(options[0].kind, 'new');
  });

  test('같은 칸에 업힌 말은 하나의 선택지로 묶인다', () => {
    const game = createGame({ teamCount: 2, piecesPerTeam: 3 });
    const [a, b, c] = game.teams[0].pieces;
    Object.assign(a, { lane: 'OUTER', index: 3 });
    Object.assign(b, { lane: 'OUTER', index: 3 });
    Object.assign(c, { lane: 'OUTER', index: 7 });
    const options = listMoveOptions(game.teams[0], 1);
    const stacked = options.find((o) => o.node === 4);
    assert.deepEqual(stacked.pieceIds.sort(), [a.id, b.id].sort());
    assert.equal(options.length, 2);
  });

  test('백도일 때는 판 위의 말만 선택할 수 있다', () => {
    const game = createGame({ teamCount: 2, piecesPerTeam: 2, backdo: true });
    Object.assign(game.teams[0].pieces[0], { lane: 'OUTER', index: 2 });
    const options = listMoveOptions(game.teams[0], -1);
    assert.equal(options.length, 1);
    assert.equal(options[0].kind, 'piece');
  });
});

describe('applyToss / applyMove', () => {
  test('윷·모가 아니면 말을 움직인 뒤 차례가 다음 팀으로 넘어간다', () => {
    const game = startGame(createGame({ teamCount: 3, piecesPerTeam: 2 }));
    applyToss(game, fixedFlats([true, false, false, false])); // 도
    assert.equal(game.turn.phase, 'MOVE');
    const outcome = applyMove(game, { kind: 'new' });
    assert.equal(outcome.to, 1);
    assert.equal(game.turn.teamIndex, 1);
    assert.equal(game.turn.phase, 'TOSS');
  });

  test('윷이 나오면 움직인 뒤에도 같은 팀이 다시 던진다', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2 }));
    applyToss(game, fixedFlats([true, true, true, true])); // 윷
    const outcome = applyMove(game, { kind: 'new' });
    assert.equal(outcome.extraTurn, true);
    assert.equal(game.turn.teamIndex, 0);
    assert.equal(game.turn.phase, 'TOSS');
  });

  test('상대 말을 잡으면 상대 말은 대기로 돌아가고 한 번 더 던진다', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2 }));
    Object.assign(game.teams[1].pieces[0], { lane: 'OUTER', index: 1 }); // 상대가 2번 칸
    applyToss(game, fixedFlats([true, true, false, false])); // 개 → 새 말이 2번 칸
    const outcome = applyMove(game, { kind: 'new' });
    assert.deepEqual(outcome.caught, [game.teams[1].pieces[0].id]);
    assert.equal(nodeOf(game.teams[1].pieces[0]), null);
    assert.equal(game.turn.teamIndex, 0);
  });

  test('자기 말 위에 멈추면 업혀서 함께 움직인다', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2 }));
    const [a, b] = game.teams[0].pieces;
    Object.assign(a, { lane: 'OUTER', index: 0 }); // 1번 칸
    applyToss(game, fixedFlats([true, false, false, false])); // 도 → 새 말 b 가 1번 칸
    applyMove(game, { kind: 'new' });
    assert.equal(nodeOf(a), 1);
    assert.equal(nodeOf(b), 1);

    // 다음 팀은 개(2칸)로 2번 칸에 들어가 우리 말을 건드리지 않고 차례를 넘긴다
    applyToss(game, fixedFlats([true, true, false, false]));
    applyMove(game, { kind: 'new' });
    applyToss(game, fixedFlats([true, true, true, false])); // 걸
    const outcome = applyMove(game, { kind: 'piece', node: 1 });
    assert.deepEqual(outcome.moved.sort(), [a.id, b.id].sort());
    assert.equal(nodeOf(a), 4);
    assert.equal(nodeOf(b), 4);
  });

  test('모든 말이 나면 게임이 끝나고 승리 팀이 기록된다', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 1 }));
    Object.assign(game.teams[0].pieces[0], { lane: 'OUTER', index: 18 }); // 19번 칸
    applyToss(game, fixedFlats([true, false, false, false])); // 도
    const outcome = applyMove(game, { kind: 'piece', node: 19 });
    assert.equal(outcome.won, true);
    assert.equal(game.status, 'FINISHED');
    assert.equal(game.winnerTeamIndex, 0);
    assert.equal(game.turn, null);
  });

  test('백도인데 판 위에 말이 없으면 차례가 바로 넘어간다', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2, backdo: true }));
    const result = applyToss(game, fixedFlats([true, false, false, false]));
    assert.equal(result.result, TOSS_RESULTS.BACKDO);
    assert.equal(result.skipped, true);
    assert.equal(game.turn.teamIndex, 1);
    assert.equal(game.turn.phase, 'TOSS');
  });

  test('선택지에 없는 말을 고르면 오류', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2 }));
    applyToss(game, fixedFlats([true, false, false, false]));
    assert.throws(() => applyMove(game, { kind: 'piece', node: 7 }), /선택할 수 없는/);
  });

  test('던지기 단계에서 움직이려 하면 오류', () => {
    const game = startGame(createGame({ teamCount: 2, piecesPerTeam: 2 }));
    assert.throws(() => applyMove(game, { kind: 'new' }), /먼저 윷을/);
  });
});

describe('normalizeSettings', () => {
  test('범위를 벗어나면 잘라내고, 이상한 값은 기본값', () => {
    assert.deepEqual(normalizeSettings({ teamCount: 9, piecesPerTeam: 0, backdo: 'yes' }), {
      teamCount: 4,
      piecesPerTeam: 1,
      backdo: true,
    });
    assert.deepEqual(normalizeSettings({ teamCount: 'abc' }), { teamCount: 2, piecesPerTeam: 2, backdo: false });
  });
});
