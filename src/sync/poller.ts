import { query } from '../db.js';
import { getPortal } from '../portals.js';
import { isConfigured, type Settings } from '../settings.js';
import { getAccount, HhClient, type HhAccount } from '../hh/client.js';
import { listActiveVacancies, listResponsesPage, type HhVacancy } from '../hh/api.js';
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

/** Опрос одного аккаунта hh.ru: находит новые отклики и ставит их в очередь */
export async function pollAccount(accountId: number): Promise<number> {
  const acc = await getAccount(accountId);
  if (!acc || !acc.active) return 0;
  const portal = await getPortal(acc.portalId);
  if (!portal || !isConfigured(portal.settings)) return 0;

  await query('UPDATE hh_accounts SET last_poll_at = now(), poll_requested = FALSE WHERE id = $1', [acc.id]);
  const hh = new HhClient(acc);
  let added = 0;
  try {
    const vacancies = vacanciesToPoll(portal.settings, await cachedVacancies(hh, acc));
    for (const vac of vacancies) {
      for (let page = 0; page < 10; page++) {
        const data = await listResponsesPage(hh, vac.id, page);
        const items: any[] = data?.items ?? [];
        if (!items.length) break;
        let newOnPage = 0;
        let reachedOld = false;
        for (const it of items) {
          const createdAt = it.created_at ? new Date(it.created_at) : null;
          if (createdAt && createdAt < acc.importSince) {
            reachedOld = true;
            continue;
          }
          const ins = await query(
            `INSERT INTO responses (portal_id, hh_account_id, negotiation_id, vacancy_id, vacancy_name, raw, hh_created_at, candidate_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (portal_id, negotiation_id) DO NOTHING RETURNING id`,
            [
              portal.id,
              acc.id,
              String(it.id),
              vac.id,
              it.vacancy?.name ?? vac.name,
              JSON.stringify(it),
              createdAt,
              [it.resume?.last_name, it.resume?.first_name].filter(Boolean).join(' ') || null,
            ],
          );
          if (ins.length) newOnPage++;
        }
        added += newOnPage;
        // страница без новых откликов или дошли до старых — дальше не листаем
        if (newOnPage === 0 || reachedOld || page >= (data.pages ?? 1) - 1) break;
      }
    }
    await query('UPDATE hh_accounts SET last_error = NULL WHERE id = $1', [acc.id]);
    if (added) await plog(portal.id, 'info', `Найдено новых откликов: ${added} (${acc.managerName || acc.employerName})`);
  } catch (e) {
    await query('UPDATE hh_accounts SET last_error = $2 WHERE id = $1', [acc.id, errText(e).slice(0, 1000)]);
    await plog(portal.id, 'error', `Ошибка опроса hh.ru (${acc.managerName || acc.employerName}): ${errText(e)}`);
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
