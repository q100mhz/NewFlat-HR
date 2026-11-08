import { query } from './db.js';

export type Level = 'info' | 'warn' | 'error';

/** Пишет событие в журнал портала (виден в интерфейсе) и в stdout */
export async function plog(portalId: number | null, level: Level, message: string, details?: unknown): Promise<void> {
  const line = `[${level}] [portal ${portalId ?? '-'}] ${message}`;
  if (level === 'error') console.error(line, details ?? '');
  else console.log(line);
  try {
    await query('INSERT INTO logs (portal_id, level, message, details) VALUES ($1, $2, $3, $4)', [
      portalId,
      level,
      message.slice(0, 2000),
      details === undefined ? null : JSON.stringify(details),
    ]);
  } catch (e) {
    console.error('Не удалось записать лог в БД', e);
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
