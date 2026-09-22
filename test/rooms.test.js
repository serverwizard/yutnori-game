import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_ROOM_IDLE_MS, LOBBY_DISCONNECT_PRUNE_MS, ROOM_IDLE_MS, RoomManager, sanitizeNickname } from '../server/rooms.js';

function managerAt(start) {
  let current = start;
  const manager = new RoomManager({ now: () => current });
  return { manager, advance: (ms) => (current += ms) };
}

const MINUTE_MS = 60 * 1000;

describe('RoomManager.sweep', () => {
  test('학생이 없는 빈 방은 10분, 학생이 있던 방은 2시간 뒤에 정리된다', () => {
    const { manager, advance } = managerAt(1_000_000);
    const empty = manager.createRoom({});
    const withPlayer = manager.createRoom({});
    manager.addPlayer(withPlayer, { nickname: '남은 친구' });
    withPlayer.game.status = 'PLAYING';

    advance(EMPTY_ROOM_IDLE_MS + MINUTE_MS);
    assert.deepEqual(manager.sweep(), [empty.code]);
    assert.ok(manager.rooms.has(withPlayer.code));

    advance(ROOM_IDLE_MS);
    assert.deepEqual(manager.sweep(), [withPlayer.code]);
  });

  test('로비에서 끊긴 채 2분이 지난 학생은 명단에서 지워지고, 게임 중이면 남는다', () => {
    const { manager, advance } = managerAt(1_000_000);
    const room = manager.createRoom({});
    room.hostSocket = {};
    const gone = manager.addPlayer(room, { nickname: '나간 친구' });
    const staying = manager.addPlayer(room, { nickname: '있는 친구' });
    staying.connected = true;
    gone.disconnectedAt = manager.now();

    advance(LOBBY_DISCONNECT_PRUNE_MS + MINUTE_MS);
    manager.sweep();
    assert.deepEqual([...room.players.keys()], [staying.id]);

    const playing = manager.createRoom({});
    playing.hostSocket = {};
    playing.game.status = 'PLAYING';
    const dropped = manager.addPlayer(playing, { nickname: '잠깐 나간 친구' });
    dropped.disconnectedAt = manager.now();
    advance(LOBBY_DISCONNECT_PRUNE_MS + MINUTE_MS);
    manager.sweep();
    assert.ok(playing.players.has(dropped.id));
  });
});

describe('createRoom', () => {
  test('원하는 코드가 비어 있으면 쓰고, 이미 있으면 새 코드를 만든다', () => {
    const { manager } = managerAt(0);
    assert.equal(manager.createRoom({}, '1234').code, '1234');
    assert.notEqual(manager.createRoom({}, '1234').code, '1234');
  });
});

describe('sanitizeNickname', () => {
  test('제어 문자와 꺾쇠를 지우고 10자로 자른다', () => {
    assert.equal(sanitizeNickname(' <b>용감한</b> 다람쥐친구들입니다 '), 'b용감한/b 다람쥐');
    assert.throws(() => sanitizeNickname('   '), /별명/);
  });
});
