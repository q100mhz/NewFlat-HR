import { config } from '../config.js';
import { query } from '../db.js';
import { getPortal } from '../portals.js';
import { refreshPortalTokens } from '../b24/client.js';
import { dueAccounts, pollAccount } from './poller.js';
import { processQueue } from './importer.js';
import { processHhActions } from './backsync.js';
import { errText, plog } from '../log.js';

let running = false;
let lastMaintenance = 0;
let timer: NodeJS.Timeout | null = null;

/**
 * Фоновый планировщик. Рассчитан на ОДИН экземпляр приложения
 * (параллельная работа нескольких копий приведёт к дублям).
 */
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const id of await dueAccounts()) await pollAccount(id);
    await processQueue();
    await processHhActions();
    if (Date.now() - lastMaintenance > 3600_000) {
      lastMaintenance = Date.now();
      await maintenance();
    }
  } catch (e) {
    console.error('[worker]', e);
  } finally {
    running = false;
  }
}

/** Раз в час: поддерживаем refresh-токены Битрикс24 живыми (живут 28 дней) и чистим журнал */
async function maintenance() {
  const stale = await query<{ id: number }>(
    `SELECT id FROM portals WHERE client_secret IS NOT NULL AND refresh_token IS NOT NULL
       AND (expires_at IS NULL OR expires_at < now() - interval '3 days')`,
  );
  for (const { id } of stale) {
    try {
      const p = await getPortal(id);
      if (p) await refreshPortalTokens(p);
    } catch (e) {
      await plog(id, 'error', `Не удалось обновить токен Битрикс24: ${errText(e)}`);
    }
  }
  await query(`DELETE FROM logs WHERE created_at < now() - make_interval(days => $1)`, [config.worker.logRetentionDays]);
}

export function startWorker() {
  const run = () => {
    tick().finally(() => {
      timer = setTimeout(run, config.worker.tickSeconds * 1000);
    });
  };
  timer = setTimeout(run, 3000);
}

export function stopWorker() {
  if (timer) clearTimeout(timer);
}
