import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { b24Routes } from './routes/b24.js';
import { hhRoutes } from './routes/hh.js';
import { apiRoutes } from './routes/api.js';
import { startWorker, stopWorker } from './sync/worker.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

await app.register(formbody);
await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/static/' });

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

await app.register(b24Routes);
await app.register(hhRoutes);
await app.register(apiRoutes);

await migrate();
await app.listen({ port: config.port, host: config.host });
console.log(`Сервер запущен: ${config.publicUrl}`);
if (!config.allowedPortals.length) console.warn('ВНИМАНИЕ: ALLOWED_PORTALS не задан — подключиться может любой портал.');
if (!config.hh.clientId) console.warn('ВНИМАНИЕ: HH_CLIENT_ID не задан — подключить hh.ru можно будет только со своими ключами портала.');
startWorker();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
