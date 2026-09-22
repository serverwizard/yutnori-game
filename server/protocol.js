/**
 * WebSocket 게임 프로토콜.
 *
 * 클라이언트 → 서버
 *   host:create {settings, preferredCode?}   방 만들기 (서버 재시작 뒤 같은 코드로 다시 만들 수 있음)
 *   host:rejoin {code, hostToken}            선생님 재접속
 *   host:settings {settings}                 로비에서 설정 변경
 *   host:start / host:lobby / host:skip
 *   host:lock {locked}
 *   host:kick {playerId} / host:move-player {playerId, teamIndex}
 *   player:join {code, nickname, teamIndex?}
 *   player:rejoin {code, playerId, token}
 *   player:team {teamIndex}                  로비에서 팀 바꾸기
 *   game:toss / game:move {choice}
 *
 * 서버 → 클라이언트
 *   host:created {code, hostToken}
 *   player:joined {code, playerId, token}
 *   state {room, event?}
 *   error {message}
 *   replaced                                  같은 계정이 다른 탭/기기에서 열림 (자동 재접속 금지)
 *   kicked
 */
import { applyMove, applyToss, GameError, nodeOf, skipTurn, startGame, teamLabel } from './game.js';
import { RoomError } from './rooms.js';

/** 소켓 하나가 초당 보낼 수 있는 메시지 수 (버스트 허용치) */
export const RATE_LIMIT_PER_SECOND = 20;
export const RATE_LIMIT_BURST = 30;
/** 방 코드 추측 방어: 없는 방 조회가 이만큼 쌓이면 연결을 끊는다 */
export const MAX_ROOM_LOOKUP_FAILURES = 5;
/** 방 생성 남용 방어 */
export const MAX_ROOMS_PER_SOCKET = 3;
/** 학교 하나가 NAT 뒤에서 같은 IP 로 보이므로 학급 수보다 넉넉하게 둔다 */
export const MAX_ROOMS_PER_IP = 50;
const ROOM_CREATE_WINDOW_MS = 10 * 60 * 1000;
/** 던질 학생의 접속이 잠깐 끊겨도 이만큼은 차례를 지켜 준다 */
export const ACTIVE_PLAYER_GRACE_MS = 5000;

export function attachProtocol(
  wss,
  rooms,
  { publicBaseUrl, roomCodePattern, now = Date.now, activeGraceMs = ACTIVE_PLAYER_GRACE_MS, maxRoomsPerIp = MAX_ROOMS_PER_IP },
) {
  const createsByIp = new Map();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    // error 리스너가 없으면 잘못된 프레임 하나에 프로세스가 죽는다
    ws.on('error', (error) => {
      console.error('[ws] 연결 오류:', error.message);
    });

    const ctx = {
      ws,
      req,
      ip: clientIp(req),
      role: null,
      room: null,
      player: null,
      bucket: { tokens: RATE_LIMIT_BURST, updatedAt: now(), warned: false },
      lookupFailures: 0,
      roomsCreated: 0,
    };
    ws.ctx = ctx;

    ws.on('message', (raw) => {
      if (!takeToken(ctx)) {
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: '메시지를 읽을 수 없어요.' });
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        send(ws, { type: 'error', message: '메시지를 읽을 수 없어요.' });
        return;
      }
      try {
        handle(ctx, message);
      } catch (error) {
        if (error instanceof GameError || error instanceof RoomError) {
          send(ws, { type: 'error', message: error.message });
          return;
        }
        console.error('[ws]', error);
        send(ws, { type: 'error', message: '서버 오류가 났어요.' });
      }
    });

    ws.on('close', () => {
      disconnect(ctx);
    });
  });

  function takeToken(ctx) {
    const bucket = ctx.bucket;
    const current = now();
    const elapsedSeconds = (current - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsedSeconds * RATE_LIMIT_PER_SECOND);
    bucket.updatedAt = current;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      bucket.warned = false;
      return true;
    }
    if (!bucket.warned) {
      bucket.warned = true;
      send(ctx.ws, { type: 'error', message: '너무 빨라요! 조금 천천히 눌러 주세요.' });
    }
    return false;
  }

  function handle(ctx, message) {
    const { type } = message;
    switch (type) {
      case 'ping':
        send(ctx.ws, { type: 'pong' });
        return;
      case 'host:create':
        hostCreate(ctx, message);
        return;
      case 'host:rejoin':
        hostRejoin(ctx, message);
        return;
      case 'player:join':
        playerJoin(ctx, message);
        return;
      case 'player:rejoin':
        playerRejoin(ctx, message);
        return;
      default:
        break;
    }
    if (!ctx.room) {
      throw new RoomError('먼저 방에 들어가야 해요.');
    }
    rooms.touch(ctx.room);
    switch (type) {
      case 'host:settings':
        requireHost(ctx);
        rooms.updateSettings(ctx.room, message.settings ?? {});
        broadcast(ctx.room);
        return;
      case 'host:start':
        requireHost(ctx);
        hostStart(ctx.room);
        return;
      case 'host:lobby':
        requireHost(ctx);
        rooms.resetGame(ctx.room);
        setActivePlayer(ctx.room, null);
        broadcast(ctx.room);
        return;
      case 'host:skip':
        requireHost(ctx);
        skipTurn(ctx.room.game);
        refreshActivePlayer(ctx.room, null);
        broadcast(ctx.room);
        return;
      case 'host:lock':
        requireHost(ctx);
        ctx.room.locked = Boolean(message.locked);
        broadcast(ctx.room);
        return;
      case 'host:kick':
        requireHost(ctx);
        hostKick(ctx.room, String(message.playerId ?? ''));
        return;
      case 'host:move-player':
        requireHost(ctx);
        rooms.movePlayer(ctx.room, String(message.playerId ?? ''), message.teamIndex);
        broadcast(ctx.room);
        return;
      case 'player:team':
        requirePlayer(ctx);
        if (ctx.room.game.status === 'PLAYING') {
          throw new RoomError('게임 중에는 팀을 바꿀 수 없어요.');
        }
        if (ctx.room.locked) {
          throw new RoomError('선생님이 방을 잠가서 팀을 바꿀 수 없어요.');
        }
        rooms.movePlayer(ctx.room, ctx.player.id, message.teamIndex);
        broadcast(ctx.room);
        return;
      case 'game:toss':
        gameToss(ctx);
        return;
      case 'game:move':
        gameMove(ctx, message.choice);
        return;
      default:
        throw new RoomError('알 수 없는 요청이에요.');
    }
  }

  // -------------------------------------------------------------------------
  // 선생님(호스트)
  // -------------------------------------------------------------------------

  function hostCreate(ctx, message) {
    if (ctx.roomsCreated >= MAX_ROOMS_PER_SOCKET || !allowCreateFromIp(ctx.ip)) {
      throw new RoomError('방을 너무 많이 만들었어요. 잠시 후 다시 시도해 주세요.');
    }
    leaveCurrentRoom(ctx);
    const preferredCode =
      typeof message.preferredCode === 'string' && roomCodePattern.test(message.preferredCode) ? message.preferredCode : null;
    const room = rooms.createRoom(message.settings ?? {}, preferredCode);
    ctx.roomsCreated += 1;
    room.baseUrl = publicBaseUrl(ctx.req);
    bindHost(ctx, room);
    send(ctx.ws, { type: 'host:created', code: room.code, hostToken: room.hostToken });
    broadcast(room);
  }

  function allowCreateFromIp(ip) {
    const current = now();
    for (const [key, entry] of createsByIp) {
      if (current - entry.windowStart > ROOM_CREATE_WINDOW_MS) {
        createsByIp.delete(key);
      }
    }
    const entry = createsByIp.get(ip) ?? { windowStart: current, count: 0 };
    if (entry.count >= maxRoomsPerIp) {
      return false;
    }
    entry.count += 1;
    createsByIp.set(ip, entry);
    return true;
  }

  function hostRejoin(ctx, message) {
    const room = lookupRoom(ctx, message.code);
    rooms.authenticateHost(room, message.hostToken);
    leaveCurrentRoom(ctx);
    room.baseUrl = publicBaseUrl(ctx.req);
    if (room.hostSocket && room.hostSocket !== ctx.ws) {
      replaceSocket(room.hostSocket);
    }
    bindHost(ctx, room);
    send(ctx.ws, { type: 'host:created', code: room.code, hostToken: room.hostToken });
    broadcast(room);
  }

  function bindHost(ctx, room) {
    ctx.role = 'host';
    ctx.room = room;
    ctx.player = null;
    room.hostSocket = ctx.ws;
    rooms.touch(room);
  }

  function hostStart(room) {
    if (room.game.status === 'PLAYING') {
      throw new RoomError('이미 게임 중이에요.');
    }
    // 매 판 첫 팀을 바꿔 공평하게 한다
    room.gamesPlayed = (room.gamesPlayed ?? 0) + 1;
    startGame(room.game, (room.gamesPlayed - 1) % room.game.teams.length);
    room.turnCursors = {};
    refreshActivePlayer(room, null);
    broadcast(room);
  }

  function hostKick(room, playerId) {
    const player = rooms.removePlayer(room, playerId);
    if (player?.socket) {
      send(player.socket, { type: 'kicked' });
      detachSocket(player.socket);
    }
    if (room.activePlayerId === playerId) {
      refreshActivePlayer(room, null);
    }
    broadcast(room);
  }

  // -------------------------------------------------------------------------
  // 학생(플레이어)
  // -------------------------------------------------------------------------

  function playerJoin(ctx, message) {
    const room = lookupRoom(ctx, message.code);
    // 같은 탭에서 들어가기를 여러 번 눌러도 학생은 한 명이다
    if (ctx.role === 'player' && ctx.room === room && ctx.player) {
      send(ctx.ws, { type: 'player:joined', code: room.code, playerId: ctx.player.id, token: ctx.player.token });
      broadcast(room);
      return;
    }
    leaveCurrentRoom(ctx);
    const player = rooms.addPlayer(room, { nickname: message.nickname, teamIndex: message.teamIndex });
    bindPlayer(ctx, room, player);
    send(ctx.ws, { type: 'player:joined', code: room.code, playerId: player.id, token: player.token });
    broadcast(room);
  }

  function playerRejoin(ctx, message) {
    const room = lookupRoom(ctx, message.code);
    const player = rooms.authenticatePlayer(room, message.playerId, message.token);
    leaveCurrentRoom(ctx);
    if (player.socket && player.socket !== ctx.ws) {
      replaceSocket(player.socket);
    }
    bindPlayer(ctx, room, player);
    send(ctx.ws, { type: 'player:joined', code: room.code, playerId: player.id, token: player.token });
    broadcast(room);
  }

  function bindPlayer(ctx, room, player) {
    ctx.role = 'player';
    ctx.room = room;
    ctx.player = player;
    player.socket = ctx.ws;
    player.connected = true;
    player.disconnectedAt = null;
    rooms.touch(room);
    // 이 팀의 차례인데 던질 학생이 없었다면 이제 막 들어온 학생이 던진다
    if (room.game.status === 'PLAYING' && room.game.turn?.teamIndex === player.teamIndex && !activePlayerAvailable(room)) {
      setActivePlayer(room, player.id);
    }
  }

  /** 없는 방을 계속 찔러 보는 연결은 끊는다 (4자리 코드 추측 방어) */
  function lookupRoom(ctx, code) {
    try {
      const room = rooms.getRoom(validCode(code));
      ctx.lookupFailures = 0;
      return room;
    } catch (error) {
      ctx.lookupFailures += 1;
      if (ctx.lookupFailures >= MAX_ROOM_LOOKUP_FAILURES) {
        send(ctx.ws, { type: 'error', message: '방 코드를 여러 번 잘못 넣었어요. 선생님께 코드를 다시 확인해 주세요.' });
        ctx.ws.close();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 게임 진행
  // -------------------------------------------------------------------------

  function gameToss(ctx) {
    const room = ctx.room;
    requireTurn(ctx);
    const before = room.game.turn.teamIndex;
    const outcome = applyToss(room.game);
    const tossEvent = {
      kind: 'toss',
      teamIndex: before,
      result: outcome.result,
      flats: outcome.flats,
      skipped: outcome.skipped,
    };
    if (outcome.skipped) {
      refreshActivePlayer(room, before);
      broadcast(room, tossEvent);
      return;
    }
    broadcast(room, tossEvent);
    // 고를 수 있는 말이 하나뿐이면 기다리지 않고 바로 움직인다
    if (outcome.options.length === 1) {
      performMove(room, { kind: outcome.options[0].kind, node: outcome.options[0].node });
    }
  }

  function gameMove(ctx, choice) {
    requireTurn(ctx);
    performMove(ctx.room, choice);
  }

  function performMove(room, choice) {
    const before = room.game.turn.teamIndex;
    const outcome = applyMove(room.game, choice);
    refreshActivePlayer(room, before);
    broadcast(room, { kind: 'move', teamIndex: before, ...outcome });
  }

  /** 차례가 다른 팀으로 넘어갔으면 그 팀에서 던질 학생을 새로 고른다. */
  function refreshActivePlayer(room, previousTeamIndex) {
    const turn = room.game.turn;
    if (!turn) {
      setActivePlayer(room, null);
      return;
    }
    if (turn.teamIndex === previousTeamIndex && activePlayerAvailable(room)) {
      return;
    }
    const picked = rooms.pickActivePlayer(room, turn.teamIndex);
    setActivePlayer(room, picked?.id ?? null);
  }

  function setActivePlayer(room, playerId) {
    clearTimeout(room.activeGraceTimer);
    room.activeGraceTimer = null;
    room.activePlayerId = playerId;
  }

  function activePlayerAvailable(room) {
    const player = room.players.get(room.activePlayerId);
    return Boolean(player?.connected);
  }

  function requireTurn(ctx) {
    const room = ctx.room;
    if (room.game.status !== 'PLAYING' || !room.game.turn) {
      throw new GameError('게임 중이 아니에요.');
    }
    if (ctx.role === 'host') {
      return;
    }
    requirePlayer(ctx);
    const turn = room.game.turn;
    if (ctx.player.teamIndex !== turn.teamIndex) {
      throw new GameError(`지금은 ${teamLabel(room.game.teams[turn.teamIndex])} 차례예요.`);
    }
    const active = room.players.get(room.activePlayerId);
    // 던질 학생이 잠깐 끊긴 동안(유예 시간)에도 다른 친구가 대신 던지지 못한다
    if (active && active.id !== ctx.player.id && (active.connected || room.activeGraceTimer)) {
      throw new GameError(`지금은 ${active.nickname} 친구가 던질 차례예요.`);
    }
  }

  function requireHost(ctx) {
    if (ctx.role !== 'host') {
      throw new RoomError('선생님만 할 수 있어요.');
    }
  }

  function requirePlayer(ctx) {
    if (ctx.role !== 'player' || !ctx.player) {
      throw new RoomError('학생만 할 수 있어요.');
    }
  }

  // -------------------------------------------------------------------------
  // 연결 관리
  // -------------------------------------------------------------------------

  /** 같은 계정이 다른 탭/기기에서 열리면 이전 화면에 알리고 끊는다. 이전 화면은 자동 재접속하지 않는다. */
  function replaceSocket(ws) {
    send(ws, { type: 'replaced' });
    detachSocket(ws);
  }

  function detachSocket(ws) {
    const previous = ws.ctx;
    if (previous) {
      previous.role = null;
      previous.room = null;
      previous.player = null;
    }
    ws.close();
  }

  function leaveCurrentRoom(ctx) {
    if (ctx.room) {
      // 로비에서 다른 방으로 옮기는 학생은 명단에서 지운다 (유령 학생 방지)
      if (ctx.role === 'player' && ctx.player && ctx.room.game.status === 'LOBBY') {
        rooms.removePlayer(ctx.room, ctx.player.id);
      }
      disconnect(ctx);
    }
    ctx.role = null;
    ctx.room = null;
    ctx.player = null;
  }

  function disconnect(ctx) {
    const room = ctx.room;
    if (!room) {
      return;
    }
    if (ctx.role === 'host' && room.hostSocket === ctx.ws) {
      room.hostSocket = null;
    }
    if (ctx.role === 'player' && ctx.player && ctx.player.socket === ctx.ws) {
      ctx.player.socket = null;
      ctx.player.connected = false;
      ctx.player.disconnectedAt = now();
      if (room.activePlayerId === ctx.player.id && room.game.status === 'PLAYING') {
        scheduleActivePlayerHandoff(room);
      }
    }
    rooms.touch(room);
    broadcast(room);
  }

  /** 던질 학생이 나갔다. 잠깐 기다려 보고 그래도 없으면 같은 팀 다른 친구에게 넘긴다. */
  function scheduleActivePlayerHandoff(room) {
    clearTimeout(room.activeGraceTimer);
    room.activeGraceTimer = setTimeout(() => {
      room.activeGraceTimer = null;
      if (room.game.status === 'PLAYING' && !activePlayerAvailable(room)) {
        refreshActivePlayer(room, null);
        broadcast(room);
      }
    }, activeGraceMs);
    room.activeGraceTimer.unref?.();
  }

  function validCode(code) {
    const text = String(code ?? '').trim();
    if (!roomCodePattern.test(text)) {
      throw new RoomError('방 코드는 숫자 4자리예요.');
    }
    return text;
  }

  // -------------------------------------------------------------------------
  // 상태 전송
  // -------------------------------------------------------------------------

  function broadcast(room, event = null) {
    const payload = JSON.stringify({ type: 'state', room: publicRoomState(room), event });
    if (room.hostSocket) {
      sendRaw(room.hostSocket, payload);
    }
    for (const player of room.players.values()) {
      if (player.socket) {
        sendRaw(player.socket, payload);
      }
    }
  }

  function publicRoomState(room) {
    const { game } = room;
    const activePlayer = room.players.get(room.activePlayerId) ?? null;
    return {
      code: room.code,
      joinUrl: `${room.baseUrl ?? ''}/r/${room.code}`,
      status: game.status,
      locked: room.locked,
      settings: game.settings,
      teams: game.teams.map((team) => ({
        index: team.index,
        name: team.name,
        emoji: team.emoji,
        color: team.color,
        pieces: team.pieces.map((piece) => ({ id: piece.id, node: nodeOf(piece), done: piece.done })),
        members: rooms.teamMembers(room, team.index).map((player) => ({
          id: player.id,
          nickname: player.nickname,
          connected: player.connected,
        })),
      })),
      turn: game.turn
        ? {
            teamIndex: game.turn.teamIndex,
            phase: game.turn.phase,
            pendingToss: game.turn.pendingToss,
            options: game.turn.options.map((option) => ({
              kind: option.kind,
              node: option.node,
              pieceIds: option.pieceIds,
              dest: option.dest.done ? { done: true, node: 20 } : { done: false, node: option.dest.node },
            })),
            activePlayerId: activePlayer?.id ?? null,
            activeNickname: activePlayer?.nickname ?? null,
          }
        : null,
      lastToss: game.lastToss,
      winnerTeamIndex: game.winnerTeamIndex,
      log: game.log,
    };
  }
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

function send(ws, message) {
  sendRaw(ws, JSON.stringify(message));
}

function sendRaw(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(payload);
  }
}
