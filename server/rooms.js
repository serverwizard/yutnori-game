/**
 * 게임방 관리자. 방은 메모리에만 존재하며, 한 반이 한 방을 쓴다.
 * 접속이 모두 끊긴 뒤 ROOM_IDLE_MS 가 지나면 정리한다.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { createGame, normalizeSettings } from './game.js';

export const ROOM_CODE_LENGTH = 4;
export const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
/** 학생이 한 명도 들어오지 않은 방은 이만큼만 비어 있어도 정리한다 */
export const EMPTY_ROOM_IDLE_MS = 10 * 60 * 1000;
/** 로비에서 접속이 끊긴 채 이만큼 지난 학생은 명단에서 지운다 */
export const LOBBY_DISCONNECT_PRUNE_MS = 2 * 60 * 1000;
export const MAX_ROOMS = 500;
export const MAX_PLAYERS_PER_ROOM = 60;
export const NICKNAME_MAX_LENGTH = 10;

export class RoomError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoomError';
  }
}

export class RoomManager {
  constructor({ now = Date.now } = {}) {
    this.rooms = new Map();
    this.now = now;
  }

  /**
   * @param {string|null} preferredCode 서버 재시작 뒤 QR 에 찍힌 코드를 그대로 살리고 싶을 때. 비어 있으면 무작위.
   */
  createRoom(rawSettings, preferredCode = null) {
    if (this.rooms.size >= MAX_ROOMS) {
      throw new RoomError('지금은 방을 더 만들 수 없어요. 잠시 후 다시 시도해 주세요.');
    }
    const code = preferredCode && !this.rooms.has(preferredCode) ? preferredCode : this.uniqueCode();
    const room = {
      code,
      hostToken: token(),
      hostSocket: null,
      locked: false,
      players: new Map(),
      turnCursors: {},
      game: createGame(rawSettings),
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  uniqueCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = String(randomInt(0, 10 ** ROOM_CODE_LENGTH)).padStart(ROOM_CODE_LENGTH, '0');
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new RoomError('방 코드를 만들 수 없어요. 다시 시도해 주세요.');
  }

  getRoom(code) {
    const room = this.rooms.get(String(code ?? '').trim());
    if (!room) {
      throw new RoomError('그런 방이 없어요. 방 코드를 다시 확인해 주세요.');
    }
    return room;
  }

  touch(room) {
    room.lastActiveAt = this.now();
  }

  updateSettings(room, rawSettings) {
    if (room.game.status === 'PLAYING') {
      throw new RoomError('게임 중에는 설정을 바꿀 수 없어요.');
    }
    this.resetGame(room, rawSettings);
  }

  /** 진행 상태와 무관하게 새 게임(로비)으로 되돌린다. 학생 명단은 유지한다. */
  resetGame(room, rawSettings = {}) {
    const previous = room.game.settings;
    const settings = normalizeSettings({ ...previous, ...rawSettings });
    room.game = createGame(settings);
    room.turnCursors = {};
    for (const player of room.players.values()) {
      if (player.teamIndex >= settings.teamCount) {
        player.teamIndex = this.smallestTeamIndex(room);
      }
    }
  }

  addPlayer(room, { nickname, teamIndex }) {
    if (room.locked) {
      throw new RoomError('선생님이 방을 잠갔어요. 선생님께 말씀해 주세요.');
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      throw new RoomError('방이 가득 찼어요.');
    }
    const name = sanitizeNickname(nickname);
    const parsedTeam = Number.parseInt(teamIndex, 10);
    const teamCount = room.game.settings.teamCount;
    const resolvedTeam =
      Number.isInteger(parsedTeam) && parsedTeam >= 0 && parsedTeam < teamCount ? parsedTeam : this.smallestTeamIndex(room);
    const player = {
      id: `p_${randomBytes(6).toString('hex')}`,
      token: token(),
      nickname: name,
      teamIndex: resolvedTeam,
      socket: null,
      connected: false,
      disconnectedAt: null,
      joinedAt: this.now(),
    };
    room.players.set(player.id, player);
    return player;
  }

  smallestTeamIndex(room) {
    const counts = new Array(room.game.settings.teamCount).fill(0);
    for (const player of room.players.values()) {
      if (player.teamIndex < counts.length) {
        counts[player.teamIndex] += 1;
      }
    }
    let best = 0;
    for (let i = 1; i < counts.length; i += 1) {
      if (counts[i] < counts[best]) {
        best = i;
      }
    }
    return best;
  }

  authenticatePlayer(room, playerId, playerToken) {
    const player = room.players.get(String(playerId ?? ''));
    if (!player || player.token !== playerToken) {
      throw new RoomError('다시 들어와 주세요.');
    }
    return player;
  }

  authenticateHost(room, hostToken) {
    if (room.hostToken !== hostToken) {
      throw new RoomError('선생님 확인에 실패했어요.');
    }
    return room;
  }

  removePlayer(room, playerId) {
    const player = room.players.get(playerId);
    room.players.delete(playerId);
    return player ?? null;
  }

  movePlayer(room, playerId, teamIndex) {
    const player = room.players.get(playerId);
    if (!player) {
      throw new RoomError('그 학생을 찾을 수 없어요.');
    }
    const parsed = Number.parseInt(teamIndex, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed >= room.game.settings.teamCount) {
      throw new RoomError('없는 팀이에요.');
    }
    player.teamIndex = parsed;
    return player;
  }

  /** 팀 안에서 다음으로 던질 학생 (접속 중인 학생만, 돌아가며) */
  pickActivePlayer(room, teamIndex) {
    const members = this.teamMembers(room, teamIndex).filter((player) => player.connected);
    if (members.length === 0) {
      return null;
    }
    const cursor = room.turnCursors[teamIndex] ?? 0;
    const chosen = members[cursor % members.length];
    room.turnCursors[teamIndex] = (cursor + 1) % members.length;
    return chosen;
  }

  teamMembers(room, teamIndex) {
    return [...room.players.values()]
      .filter((player) => player.teamIndex === teamIndex)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  hasAnyConnection(room) {
    if (room.hostSocket) {
      return true;
    }
    for (const player of room.players.values()) {
      if (player.connected) {
        return true;
      }
    }
    return false;
  }

  /** 오래 비어 있는 방 정리와 로비 유령 학생 정리. 정리된 방 코드 목록을 돌려준다. */
  sweep() {
    const removed = [];
    for (const [code, room] of this.rooms) {
      this.pruneLobbyPlayers(room);
      if (this.hasAnyConnection(room)) {
        continue;
      }
      const idleLimit = room.players.size === 0 ? EMPTY_ROOM_IDLE_MS : ROOM_IDLE_MS;
      if (this.now() - room.lastActiveAt > idleLimit) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  /** 게임 전(로비)에 나가서 돌아오지 않는 학생은 명단에서 지운다. 게임 중에는 재접속을 위해 남긴다. */
  pruneLobbyPlayers(room) {
    if (room.game.status !== 'LOBBY') {
      return [];
    }
    const pruned = [];
    for (const [id, player] of room.players) {
      if (!player.connected && player.disconnectedAt && this.now() - player.disconnectedAt > LOBBY_DISCONNECT_PRUNE_MS) {
        room.players.delete(id);
        pruned.push(id);
      }
    }
    return pruned;
  }
}

const CONTROL_CHARACTERS = /[\p{Cc}<>]/gu;

export function sanitizeNickname(raw) {
  const name = String(raw ?? '')
    .replace(CONTROL_CHARACTERS, '')
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
  if (name.length === 0) {
    throw new RoomError('별명을 입력해 주세요.');
  }
  return name;
}

function token() {
  return randomBytes(16).toString('hex');
}
