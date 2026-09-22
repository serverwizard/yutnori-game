/**
 * 윷놀이 서버 진입점. PORT 환경변수(기본 3000)로 listen 한다.
 */
import { createApp } from './app.js';

const DEFAULT_PORT = 3000;
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
const SHUTDOWN_GRACE_MS = 3000;

const app = createApp();

app.server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http://localhost:${PORT} 에서 윷놀이 서버 시작`);
});

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});
process.on('SIGINT', () => {
  shutdown();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});
