import { createServer } from 'vite';
import { createGameServer } from './server.mjs';

const game = createGameServer({ dataPath: 'data/profiles.sqlite' });
let vite;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([vite?.close(), game.close()]);
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
try {
  await new Promise((resolve, reject) => {
    if (game.server.listening) resolve();
    else {
      game.server.once('listening', resolve);
      game.server.once('error', reject);
    }
  });
  vite = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
  await vite.listen();
  vite.printUrls();
  console.log('Multiplayer ready: /ws → 127.0.0.1:3001');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close();
}
