import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

const WAIT_MS = 3000;
const MAX_TURNS = 400;
const ACTIVE_GRACE_MS = 150;
const OVERSIZED_PAYLOAD = 'x'.repeat(20 * 1024);

let app;
let baseUrl;

before(async () => {
  // 테스트는 모두 같은 IP 에서 방을 수십 개 만들므로 IP 한도는 넉넉히 두고, 한도 자체는 별도 앱으로 검사한다
  app = createApp({ publicUrl: 'https://yut.example.com', log: () => {}, activeGraceMs: ACTIVE_GRACE_MS, maxRoomsPerIp: 10_000 });
  await new Promise((resolve) => app.server.listen(0, resolve));
  baseUrl = `http://localhost:${app.server.address().port}`;
});

after(async () => {
  await app.close();
});

/** 메시지를 종류별로 모아 두고 원하는 종류를 기다릴 수 있는 테스트용 클라이언트 */
async function openClient() {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    inbox.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    /** 이미 도착한 것 중에서 먼저 찾고, 없으면 새로 오는 것을 기다린다 */
    next(predicate, timeoutMs = WAIT_MS) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) {
        return Promise.resolve(inbox.splice(index, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('메시지를 기다리다 시간이 지났어요')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    /** 지금까지 받은 state 중 마지막 것 (큐를 비운다) */
    latestState() {
      let latest = null;
      for (let i = inbox.length - 1; i >= 0; i -= 1) {
        if (inbox[i].type === 'state') {
          latest = inbox[i];
          break;
        }
      }
      inbox.length = 0;
      return latest;
    },
    close() {
      ws.close();
    },
  };
}

const isType = (type) => (message) => message.type === type;
const isStateWhere = (predicate) => (message) => message.type === 'state' && predicate(message.room, message.event);

describe('방 만들기와 입장', () => {
  test('선생님이 방을 만들면 코드·토큰과 함께 로비 상태를 받는다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: { teamCount: 3 } });
    const created = await host.next(isType('host:created'));
    assert.match(created.code, /^\d{4}$/);
    assert.equal(typeof created.hostToken, 'string');
    const state = await host.next(isType('state'));
    assert.equal(state.room.status, 'LOBBY');
    assert.equal(state.room.teams.length, 3);
    assert.equal(state.room.joinUrl, `https://yut.example.com/r/${created.code}`);
    host.close();
  });

  test('학생은 코드로 들어가고 가장 적은 팀에 자동 배정된다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));

    const a = await openClient();
    a.send({ type: 'player:join', code, nickname: '용감한 다람쥐' });
    const joinedA = await a.next(isType('player:joined'));
    assert.equal(joinedA.code, code);

    const b = await openClient();
    b.send({ type: 'player:join', code, nickname: '씩씩한 펭귄' });
    await b.next(isType('player:joined'));
    const state = await b.next(isStateWhere((room) => room.teams.flatMap((t) => t.members).length === 2));
    assert.deepEqual(
      state.room.teams.map((t) => t.members.length),
      [1, 1],
    );
    host.close();
    a.close();
    b.close();
  });

  test('없는 방 코드, 잠긴 방, 빈 별명은 오류', async () => {
    const stranger = await openClient();
    stranger.send({ type: 'player:join', code: '0000', nickname: '누구' });
    assert.match((await stranger.next(isType('error'))).message, /그런 방이 없어요/);

    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));
    stranger.send({ type: 'player:join', code, nickname: '   ' });
    assert.match((await stranger.next(isType('error'))).message, /별명/);

    host.send({ type: 'host:lock', locked: true });
    await host.next(isStateWhere((room) => room.locked));
    stranger.send({ type: 'player:join', code, nickname: '늦은 친구' });
    assert.match((await stranger.next(isType('error'))).message, /잠갔어요/);

    host.close();
    stranger.close();
  });

  test('학생은 선생님 명령을 쓸 수 없다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));
    const a = await openClient();
    a.send({ type: 'player:join', code, nickname: '장난꾸러기' });
    await a.next(isType('player:joined'));
    a.send({ type: 'host:start' });
    assert.match((await a.next(isType('error'))).message, /선생님만/);
    host.close();
    a.close();
  });
});

describe('게임 진행', () => {
  test('학생들이 돌아가며 던지고, 자기 차례가 아니면 막히며, 끝까지 진행되면 승리 팀이 나온다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: { teamCount: 2, piecesPerTeam: 1 } });
    const { code } = await host.next(isType('host:created'));

    const players = [];
    for (const [nickname, teamIndex] of [
      ['호랑이1', 0],
      ['호랑이2', 0],
      ['토끼1', 1],
    ]) {
      const client = await openClient();
      client.send({ type: 'player:join', code, nickname, teamIndex });
      const joined = await client.next(isType('player:joined'));
      players.push({ client, id: joined.playerId, nickname, teamIndex });
    }

    host.send({ type: 'host:start' });
    let state = await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    assert.equal(state.room.turn.teamIndex, 0);
    assert.equal(state.room.turn.activeNickname, '호랑이1');

    // 다른 팀 학생이 던지면 거절된다
    const rabbit = players.find((p) => p.nickname === '토끼1');
    rabbit.client.send({ type: 'game:toss' });
    assert.match((await rabbit.client.next(isType('error'))).message, /차례예요/);

    // 같은 팀이지만 차례가 아닌 학생도 거절된다
    const tiger2 = players.find((p) => p.nickname === '호랑이2');
    tiger2.client.send({ type: 'game:toss' });
    assert.match((await tiger2.client.next(isType('error'))).message, /호랑이1 친구가/);

    // 실제 진행: 서버가 알려주는 차례 학생이 던지고, 말이 여러 개면 첫 선택지를 고른다
    const byId = new Map(players.map((p) => [p.id, p]));
    const tigerTurnPlayers = new Set();
    let turns = 0;
    while (state.room.status === 'PLAYING' && turns < MAX_TURNS) {
      turns += 1;
      const { turn } = state.room;
      const actor = turn.activePlayerId ? byId.get(turn.activePlayerId).client : host;
      if (turn.teamIndex === 0 && turn.activePlayerId) {
        tigerTurnPlayers.add(turn.activePlayerId);
      }
      if (turn.phase === 'TOSS') {
        actor.send({ type: 'game:toss' });
        state = await host.next(isStateWhere((room, event) => event?.kind === 'toss'));
        // 선택지가 하나면 서버가 바로 움직인 상태가 뒤따라온다
        if (!state.event.skipped && state.room.turn?.phase === 'MOVE' && state.room.turn.options.length === 1) {
          state = await host.next(isStateWhere((room, event) => event?.kind === 'move'));
        }
      } else {
        const option = turn.options[0];
        actor.send({ type: 'game:move', choice: { kind: option.kind, node: option.node } });
        state = await host.next(isStateWhere((room, event) => event?.kind === 'move'));
      }
    }

    assert.equal(state.room.status, 'FINISHED', `${turns}번 안에 끝나야 해요`);
    assert.ok([0, 1].includes(state.room.winnerTeamIndex));
    const winner = state.room.teams[state.room.winnerTeamIndex];
    assert.ok(winner.pieces.every((piece) => piece.done));
    assert.equal(state.room.turn, null);
    // 호랑이팀 학생 둘이 번갈아 던졌다
    assert.equal(tigerTurnPlayers.size, 2);

    // 다시 하기
    host.send({ type: 'host:start' });
    state = await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    assert.ok(state.room.teams.every((team) => team.pieces.every((piece) => !piece.done && piece.node === null)));

    host.close();
    players.forEach((p) => p.client.close());
  });

  test('차례인 학생이 나가면 같은 팀 다른 학생이 던질 수 있고, 아무도 없으면 선생님이 던진다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: { teamCount: 2, piecesPerTeam: 1 } });
    const { code } = await host.next(isType('host:created'));

    const a = await openClient();
    a.send({ type: 'player:join', code, nickname: '먼저', teamIndex: 0 });
    const joinedA = await a.next(isType('player:joined'));
    const b = await openClient();
    b.send({ type: 'player:join', code, nickname: '나중', teamIndex: 0 });
    const joinedB = await b.next(isType('player:joined'));

    host.send({ type: 'host:start' });
    let state = await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    assert.equal(state.room.turn.activePlayerId, joinedA.playerId);

    a.close();
    // 끊긴 직후에는 유예 시간 동안 차례를 지켜 주고, 그 뒤에 넘어간다
    state = await host.next(isStateWhere((room) => room.teams[0].members.some((m) => m.id === joinedA.playerId && !m.connected)));
    assert.equal(state.room.turn.activePlayerId, joinedA.playerId);
    state = await host.next(isStateWhere((room) => room.turn?.activePlayerId === joinedB.playerId));
    assert.equal(state.room.turn.activeNickname, '나중');

    b.close();
    state = await host.next(isStateWhere((room) => room.turn?.activePlayerId === null));
    host.send({ type: 'game:toss' });
    state = await host.next(isStateWhere((room, event) => event?.kind === 'toss'));
    assert.ok(['도', '개', '걸', '윷', '모'].includes(state.event.result.name));
    host.close();
  });

  test('선생님이 차례를 건너뛰면 다음 팀으로 넘어간다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: { teamCount: 3 } });
    await host.next(isType('host:created'));
    host.send({ type: 'host:start' });
    await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    host.send({ type: 'host:skip' });
    const state = await host.next(isStateWhere((room) => room.turn?.teamIndex === 1));
    assert.equal(state.room.turn.phase, 'TOSS');
    host.close();
  });
});

describe('재접속', () => {
  test('학생이 토큰으로 다시 들어오면 같은 사람으로 이어지고, 이전 연결은 replaced 를 받는다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));

    const first = await openClient();
    first.send({ type: 'player:join', code, nickname: '다람쥐' });
    const joined = await first.next(isType('player:joined'));

    const second = await openClient();
    second.send({ type: 'player:rejoin', code, playerId: joined.playerId, token: joined.token });
    const rejoined = await second.next(isType('player:joined'));
    assert.equal(rejoined.playerId, joined.playerId);
    assert.equal((await first.next(isType('replaced'))).type, 'replaced');

    const state = await second.next(isStateWhere((room) => room.teams.flatMap((t) => t.members).length === 1));
    assert.equal(state.room.teams.flatMap((t) => t.members)[0].nickname, '다람쥐');

    second.send({ type: 'player:rejoin', code, playerId: joined.playerId, token: 'wrong' });
    assert.match((await second.next(isType('error'))).message, /다시 들어와/);

    host.close();
    second.close();
  });

  test('선생님은 토큰으로 방을 다시 열 수 있고 틀린 토큰은 거절된다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code, hostToken } = await host.next(isType('host:created'));
    host.close();

    const again = await openClient();
    again.send({ type: 'host:rejoin', code, hostToken: 'nope' });
    assert.match((await again.next(isType('error'))).message, /선생님 확인/);
    again.send({ type: 'host:rejoin', code, hostToken });
    assert.equal((await again.next(isType('host:created'))).code, code);
    again.close();
  });
});

describe('HTTP', () => {
  test('앱 경로는 index.html, QR 은 공개 주소를 담은 SVG', async () => {
    for (const path of ['/', '/host', '/host/1234', '/r/1234']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
    }
    const qr = await fetch(`${baseUrl}/qr/1234.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    assert.match(await qr.text(), /^<svg/);
    assert.equal((await fetch(`${baseUrl}/qr/12.svg`)).status, 404);
    const tossQr = await fetch(`${baseUrl}/qr/toss.svg`);
    assert.equal(tossQr.status, 200);
    assert.match(tossQr.headers.get('content-type'), /svg/);
    // 윷 던지기 전용 모드 (예전 반별 주소도 같은 화면으로 열린다)
    for (const path of ['/toss', '/toss/3-1']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
    }
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/server/game.js`)).status, 404);
  });
});

describe('남용 방어', () => {
  test('너무 큰 프레임을 보내도 서버는 살아 있다', async () => {
    const attacker = await openClient();
    attacker.ws.send(OVERSIZED_PAYLOAD);
    await new Promise((resolve) => attacker.ws.once('close', resolve));

    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    assert.match((await host.next(isType('host:created'))).code, /^\d{4}$/);
    host.close();
  });

  test('같은 연결에서 들어가기를 여러 번 눌러도 학생은 한 명', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));
    const a = await openClient();
    a.send({ type: 'player:join', code, nickname: '급한 친구' });
    a.send({ type: 'player:join', code, nickname: '급한 친구' });
    a.send({ type: 'player:join', code, nickname: '급한 친구' });
    const first = await a.next(isType('player:joined'));
    const second = await a.next(isType('player:joined'));
    const third = await a.next(isType('player:joined'));
    assert.equal(first.playerId, second.playerId);
    assert.equal(second.playerId, third.playerId);
    const state = await host.next(isStateWhere((room) => room.teams.flatMap((t) => t.members).length === 1));
    assert.equal(state.room.teams.flatMap((t) => t.members).length, 1);
    host.close();
    a.close();
  });

  test('로비에서 다른 방으로 옮기면 이전 방 명단에서 사라진다', async () => {
    const hostA = await openClient();
    hostA.send({ type: 'host:create', settings: {} });
    const { code: codeA } = await hostA.next(isType('host:created'));
    const hostB = await openClient();
    hostB.send({ type: 'host:create', settings: {} });
    const { code: codeB } = await hostB.next(isType('host:created'));

    const student = await openClient();
    student.send({ type: 'player:join', code: codeA, nickname: '떠돌이' });
    await student.next(isType('player:joined'));
    await hostA.next(isStateWhere((room) => room.teams.flatMap((t) => t.members).length === 1));
    student.send({ type: 'player:join', code: codeB, nickname: '떠돌이' });
    await student.next(isType('player:joined'));
    const stateA = await hostA.next(isStateWhere((room) => room.teams.flatMap((t) => t.members).length === 0));
    assert.equal(stateA.room.teams.flatMap((t) => t.members).length, 0);
    hostA.close();
    hostB.close();
    student.close();
  });

  test('잠긴 방에서는 팀을 바꿀 수 없다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {} });
    const { code } = await host.next(isType('host:created'));
    const a = await openClient();
    a.send({ type: 'player:join', code, nickname: '옮기고 싶은 친구', teamIndex: 0 });
    await a.next(isType('player:joined'));
    host.send({ type: 'host:lock', locked: true });
    await a.next(isStateWhere((room) => room.locked));
    a.send({ type: 'player:team', teamIndex: 1 });
    assert.match((await a.next(isType('error'))).message, /잠가서/);
    host.close();
    a.close();
  });

  test('없는 방 코드를 다섯 번 넣으면 연결이 끊긴다', async () => {
    const guesser = await openClient();
    const closed = new Promise((resolve) => guesser.ws.once('close', resolve));
    for (const code of ['0001', '0002', '0003', '0004', '0005']) {
      guesser.send({ type: 'player:join', code, nickname: '추측' });
    }
    await closed;
    assert.equal(guesser.ws.readyState, WebSocket.CLOSED);
  });

  test('연결 하나가 만들 수 있는 방 수에는 한도가 있다', async () => {
    const greedy = await openClient();
    for (let i = 0; i < 3; i += 1) {
      greedy.send({ type: 'host:create', settings: {} });
      await greedy.next(isType('host:created'));
    }
    greedy.send({ type: 'host:create', settings: {} });
    assert.match((await greedy.next(isType('error'))).message, /너무 많이/);
    greedy.close();
  });

  test('같은 IP 에서 만들 수 있는 방 수에도 한도가 있다', async () => {
    const strict = createApp({ publicUrl: 'https://yut.example.com', log: () => {}, maxRoomsPerIp: 2 });
    await new Promise((resolve) => strict.server.listen(0, resolve));
    const url = `ws://localhost:${strict.server.address().port}/ws`;
    try {
      const results = [];
      for (let i = 0; i < 3; i += 1) {
        const ws = new WebSocket(url);
        await new Promise((resolve) => ws.once('open', resolve));
        ws.send(JSON.stringify({ type: 'host:create', settings: {} }));
        const reply = await new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
        results.push(reply.type);
        ws.close();
      }
      assert.deepEqual(results, ['host:created', 'host:created', 'error']);
    } finally {
      await strict.close();
    }
  });

  test('메시지를 쏟아부으면 속도 제한 안내를 받는다', async () => {
    const spammer = await openClient();
    for (let i = 0; i < 60; i += 1) {
      spammer.send({ type: 'ping' });
    }
    assert.match((await spammer.next(isType('error'))).message, /천천히/);
    spammer.close();
  });
});

describe('방 코드 유지와 첫 팀 교대', () => {
  test('원하는 코드가 비어 있으면 그 코드로 방을 만든다 (서버 재시작 뒤 QR 살리기)', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: {}, preferredCode: '4242' });
    const created = await host.next(isType('host:created'));
    assert.equal(created.code, '4242');

    const other = await openClient();
    other.send({ type: 'host:create', settings: {}, preferredCode: '4242' });
    const second = await other.next(isType('host:created'));
    assert.notEqual(second.code, '4242');
    host.close();
    other.close();
  });

  test('다시 시작할 때마다 먼저 던지는 팀이 바뀐다', async () => {
    const host = await openClient();
    host.send({ type: 'host:create', settings: { teamCount: 3 } });
    await host.next(isType('host:created'));
    host.send({ type: 'host:start' });
    let state = await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    assert.equal(state.room.turn.teamIndex, 0);
    host.send({ type: 'host:lobby' });
    await host.next(isStateWhere((room) => room.status === 'LOBBY'));
    host.send({ type: 'host:start' });
    state = await host.next(isStateWhere((room) => room.status === 'PLAYING'));
    assert.equal(state.room.turn.teamIndex, 1);
    host.close();
  });
});
