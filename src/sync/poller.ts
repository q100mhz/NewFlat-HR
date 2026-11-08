import { query } from '../db.js';
import { getPortal } from '../portals.js';
import { isConfigured, type Settings } from '../settings.js';
import { getAccount, HhClient, type HhAccount } from '../hh/client.js';
import {
  listActiveVacancies,
  listArchivedVacancies,
  listCollectionPage,
  listCollectionUrls,
  listResponsesPage,
  type HhVacancy,
} from '../hh/api.js';
import { errText, plog } from '../log.js';

const vacancyCache = new Map<number, { at: number; items: HhVacancy[] }>();

export async function cachedVacancies(hh: HhClient, acc: HhAccount, force = false): Promise<HhVacancy[]> {
  const c = vacancyCache.get(acc.id);
  if (!force && c && Date.now() - c.at < 10 * 60_000) return c.items;
  const items = await listActiveVacancies(hh, acc.employerId, acc.managerId);
  vacancyCache.set(acc.id, { at: Date.now(), items });
  return items;
}

/** Какие вакансии опрашивать согласно настройкам */
export function vacanciesToPoll(s: Settings, active: HhVacancy[]): HhVacancy[] {
  if (s.vacancyMode === 'selected') return active.filter((v) => s.vacancies[v.id]?.enabled === true);
  return active.filter((v) => s.vacancies[v.id]?.enabled !== false);
}

const HOUR = 3600_000;
const FULL_SCAN_EVERY = 24 * HOUR; // плановая сверка раз в сутки…
const FULL_SCAN_DEPTH = 3 * 24 * HOUR; // …за последние 3 дня
const OVERLAP = HOUR; // запас при догрузке после сбоя

export interface PollPlan {
  mode: 'quick' | 'full';
  from: Date;
  reason: 'regular' | 'manual' | 'outage' | 'first' | 'scheduled';
}

/**
 * Решает, достаточно ли быстрого опроса новых откликов, или нужна полная сверка.
 * Полная сверка проходит по ВСЕМ стадиям откликов (в т.ч. уже разобранным в hh.ru)
 * и по вакансиям, закрытым за этот период, — так отклики, пришедшие во время сбоя,
 * не теряются, даже если рекрутер успел обработать их в hh.ru.
 */
export function planPoll(acc: Pick<HhAccount, 'lastSuccessAt' | 'lastFullScanAt' | 'catchupFrom' | 'importSince'>, intervalMinutes: number, now = new Date()): PollPlan {
  const clamp = (d: Date) => (d < acc.importSince ? acc.importSince : d);
  if (acc.catchupFrom) return { mode: 'full', from: acc.catchupFrom, reason: 'manual' };
  if (!acc.lastSuccessAt) return { mode: 'full', from: acc.importSince, reason: 'first' };
  const gap = now.getTime() - acc.lastSuccessAt.getTime();
  if (gap > intervalMinutes * 60_000 * 2 + 5 * 60_000) {
    return { mode: 'full', from: clamp(new Date(acc.lastSuccessAt.getTime() - OVERLAP)), reason: 'outage' };
  }
  if (!acc.lastFullScanAt || now.getTime() - acc.lastFullScanAt.getTime() > FULL_SCAN_EVERY) {
    return { mode: 'full', from: clamp(new Date(now.getTime() - FULL_SCAN_DEPTH)), reason: 'scheduled' };
  }
  return { mode: 'quick', from: clamp(new Date(acc.lastSuccessAt.getTime() - OVERLAP)), reason: 'regular' };
}

/** Сохраняет отклики страницы. Возвращает число новых и признак «вся страница старше from». */
async function savePage(portalId: number, acc: HhAccount, vac: HhVacancy, items: any[], from: Date, viaCatchup: boolean) {
  let added = 0;
  let allOld = items.length > 0;
  for (const it of items) {
    const createdAt = it.created_at ? new Date(it.created_at) : null;
    if (createdAt && createdAt < from) continue;
    allOld = false;
    const ins = await query(
      `INSERT INTO responses (portal_id, hh_account_id, negotiation_id, vacancy_id, vacancy_name, raw, hh_created_at, candidate_name, via_catchup)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (portal_id, negotiation_id) DO NOTHING RETURNING id`,
      [
        portalId,
        acc.id,
        String(it.id),
        vac.id,
        it.vacancy?.name ?? vac.name,
        JSON.stringify(it),
        createdAt,
        [it.resume?.last_name, it.resume?.first_name].filter(Boolean).join(' ') || null,
        viaCatchup,
      ],
    );
    if (ins.length) added++;
  }
  return { added, allOld };
}

/** Опрос одного аккаунта hh.ru: находит новые (и пропущенные) отклики и ставит их в очередь */
export async function pollAccount(accountId: number): Promise<number> {
  const acc = await getAccount(accountId);
  if (!acc || !acc.active) return 0;
  const portal = await getPortal(acc.portalId);
  if (!portal || !isConfigured(portal.settings)) return 0;

  const plan = planPoll(acc, portal.settings.pollIntervalMinutes);
  const full = plan.mode === 'full';
  const viaCatchup = plan.reason === 'manual' || plan.reason === 'outage';
  await query('UPDATE hh_accounts SET last_poll_at = now(), poll_requested = FALSE WHERE id = $1', [acc.id]);
  const hh = new HhClient(acc);
  const who = acc.managerName || acc.employerName;
  let added = 0;
  try {
    let vacancies = await cachedVacancies(hh, acc, full);
    if (full) {
      try {
        const archived = await listArchivedVacancies(hh, acc.employerId, acc.managerId, plan.from);
        const known = new Set(vacancies.map((v) => v.id));
        vacancies = [...vacancies, ...archived.filter((v) => !known.has(v.id))];
      } catch (e) {
        await plog(portal.id, 'warn', `Не удалось получить архивные вакансии (${who}): ${errText(e)}`);
      }
    }
    vacancies = vacanciesToPoll(portal.settings, vacancies);

    for (const vac of vacancies) {
      if (!full) {
        // быстрый режим: только неразобранные отклики, листаем пока есть новые
        for (let page = 0; page < 20; page++) {
          const data = await listResponsesPage(hh, vac.id, page);
          const items: any[] = data?.items ?? [];
          if (!items.length) break;
          const r = await savePage(portal.id, acc, vac, items, plan.from, false);
          added += r.added;
          if (r.added === 0 || r.allOld || page >= (data.pages ?? 1) - 1) break;
        }
        continue;
      }
      // полная сверка: все стадии откликов, до откликов старше plan.from
      for (const url of await listCollectionUrls(hh, vac.id)) {
        for (let page = 0; page < 40; page++) {
          const data = await listCollectionPage(hh, url, page);
          const items: any[] = data?.items ?? [];
          if (!items.length) break;
          const r = await savePage(portal.id, acc, vac, items, plan.from, viaCatchup);
          added += r.added;
          if (r.allOld || page >= (data.pages ?? 1) - 1) break;
        }
      }
    }

    await query(
      `UPDATE hh_accounts SET last_error = NULL, last_success_at = now()${full ? ', last_full_scan_at = now(), catchup_from = NULL' : ''} WHERE id = $1`,
      [acc.id],
    );
    if (plan.reason === 'outage' || plan.reason === 'manual') {
      const since = plan.from.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
      await plog(portal.id, added ? 'warn' : 'info',
        `${plan.reason === 'manual' ? 'Догрузка по запросу' : 'Связь с hh.ru восстановлена'} (${who}): проверены отклики с ${since} МСК, догружено пропущенных: ${added}`);
    } else if (added) {
      await plog(portal.id, 'info', `${plan.reason === 'scheduled' ? 'Плановая сверка нашла' : 'Найдено новых'} откликов: ${added} (${who})`);
    }
  } catch (e) {
    await query('UPDATE hh_accounts SET last_error = $2 WHERE id = $1', [acc.id, errText(e).slice(0, 1000)]);
    await plog(portal.id, 'error', `Ошибка опроса hh.ru (${who}): ${errText(e)}. Пропущенные отклики будут догружены автоматически после восстановления.`);
  }
  return added;
}

/** Аккаунты, которые пора опросить */
export async function dueAccounts(): Promise<number[]> {
  const rows = await query<{ id: number; settings: any; last_poll_at: Date | null; poll_requested: boolean }>(
    `SELECT a.id, p.settings, a.last_poll_at, a.poll_requested
     FROM hh_accounts a JOIN portals p ON p.id = a.portal_id WHERE a.active`,
  );
  const now = Date.now();
  return rows
    .filter((r) => {
      if (r.poll_requested || !r.last_poll_at) return true;
      const interval = Number(r.settings?.pollIntervalMinutes) || 3;
      return now - r.last_poll_at.getTime() >= interval * 60_000;
    })
    .map((r) => r.id);
}
