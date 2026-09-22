/**
 * 윷놀이 서버 구성(HTTP 정적 파일 + QR + WebSocket). 진입점은 index.js.
 *  - 정적 파일(public/) 제공
 *  - /qr/:code.svg  방 입장 QR 코드
 *  - /ws            WebSocket 게임 프로토콜 (protocol.js)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { attachProtocol } from './protocol.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const SWEEP_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const ROOM_CODE_PATTERN = /^\d{4}$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const REVALIDATE_EXTENSIONS = new Set(['.html', '.js', '.css']);

/** 클라이언트 라우터가 처리하는 경로. 모두 index.html 을 돌려준다. */
const APP_ROUTES = [/^\/$/, /^\/host(\/\d{4})?$/, /^\/r\/\d{4}$/, /^\/join$/, /^\/toss(\/[^/]{1,80})?$/];

/**
 * HTTP + WebSocket 서버를 만든다. listen 은 호출자가 한다.
 * @param {{ publicUrl?: string, log?: (message: string) => void }} options
 */
export function createApp({ publicUrl = process.env.PUBLIC_URL, log = console.log, activeGraceMs, maxRoomsPerIp } = {}) {
  const rooms = new RoomManager();
  const baseUrlOf = (req) => publicBaseUrl(req, publicUrl);

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, baseUrlOf);
    } catch (error) {
      console.error('[http]', error);
      if (!res.headersSent) {
        sendText(res, 500, '서버 오류가 났어요.');
      } else {
        res.end();
      }
    }
  });
  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on('error', (error) => console.error('[wss]', error));

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws' || !isAllowedOrigin(req, publicUrl)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  attachProtocol(wss, rooms, { publicBaseUrl: baseUrlOf, roomCodePattern: ROOM_CODE_PATTERN, activeGraceMs, maxRoomsPerIp });

  /** 끊어진 연결 감지 (프록시가 조용히 끊는 경우 대비) */
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const sweeper = setInterval(() => {
    const removed = rooms.sweep();
    if (removed.length > 0) {
      log(`[sweep] 비어 있는 방 ${removed.length}개 정리: ${removed.join(', ')}`);
    }
  }, SWEEP_INTERVAL_MS);

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, wss, rooms, close };
}

async function handleHttp(req, res, baseUrlOf) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }
  if (path === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }
  const qrMatch = path.match(/^\/qr\/(\d{4})\.svg$/);
  if (qrMatch) {
    await sendQr(res, `${baseUrlOf(req)}/r/${qrMatch[1]}`);
    return;
  }
  if (APP_ROUTES.some((route) => route.test(path))) {
    await sendFile(res, join(PUBLIC_DIR, 'index.html'), 'no-cache');
    return;
  }
  await sendStatic(res, path);
}

async function sendQr(res, joinUrl) {
  const svg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.svg'], 'Cache-Control': 'public, max-age=86400' });
  res.end(svg);
}

async function sendStatic(res, path) {
  const filePath = resolve(join(PUBLIC_DIR, path));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  // html/js/css 는 배포 직후 모든 기기가 같은 버전을 받도록 매번 검사하고, 그 외 파일은 한 시간 캐시한다
  const cacheControl = REVALIDATE_EXTENSIONS.has(extname(filePath)) ? 'no-cache' : 'public, max-age=3600';
  await sendFile(res, filePath, cacheControl);
}

async function sendFile(res, filePath, cacheControl) {
  const body = await readFile(filePath);
  const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * 브라우저가 보낸 Origin 이 이 서버 자신이 아니면 WebSocket 을 거절한다.
 * (다른 사이트에 심어진 스크립트가 게임방을 조작하는 것을 막는다. Origin 이 없는 비브라우저 클라이언트는 허용)
 */
export function isAllowedOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const allowedHosts = new Set([req.headers.host, req.headers['x-forwarded-host']].filter(Boolean));
  if (publicUrl) {
    try {
      allowedHosts.add(new URL(publicUrl).host);
    } catch {
      // PUBLIC_URL 이 잘못돼 있어도 나머지 후보로 판단한다
    }
  }
  return allowedHosts.has(originHost);
}

/**
 * 학생이 접속할 공개 주소. 배포 환경에서는 PUBLIC_URL 로 고정할 수 있고,
 * 없으면 프록시가 넘겨준 헤더로 추정한다.
 */
export function publicBaseUrl(req, publicUrl) {
  if (publicUrl) {
    return publicUrl.replace(/\/+$/, '');
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}
