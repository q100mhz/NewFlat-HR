import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { B24Client } from '../b24/client.js';
import { getPortal } from '../portals.js';
import { hhClientFor } from '../hh/client.js';
import { applyNegotiationAction } from '../hh/api.js';
import { HH_ACTIONS } from '../settings.js';
import { errText, plog } from '../log.js';

/**
 * Обработка события изменения карточки в Битрикс24.
 * Данным события не доверяем: перечитываем карточку своим токеном.
 */
export async function onItemUpdated(portalId: number, entityTypeId: number, itemId: number): Promise<void> {
  const row = await queryOne<{ id: number; b24_stage_id: string | null; negotiation_id: string }>(
    `SELECT id, b24_stage_id, negotiation_id FROM responses WHERE portal_id = $1 AND b24_entity_type_id = $2 AND b24_item_id = $3`,
    [portalId, entityTypeId, itemId],
  );
  if (!row) return; // карточка создана не нашим приложением
  const portal = await getPortal(portalId);
  if (!portal) return;
  const b24 = new B24Client(portal);
  const res = await b24.call('crm.item.get', { entityTypeId, id: itemId });
  const stageId: string | undefined = res?.item?.stageId;
  if (!stageId || stageId === row.b24_stage_id) return;

  await query('UPDATE responses SET b24_stage_id = $2 WHERE id = $1', [row.id, stageId]);
  const sync = portal.settings.hhSync;
  const rule = sync.enabled ? sync.stageActions[stageId] : undefined;
  if (!rule?.action) return;

  await query(
    `UPDATE responses SET hh_action = $2, hh_action_message = $3, hh_action_attempts = 0,
       hh_action_next_at = now(), hh_action_error = NULL WHERE id = $1`,
    [row.id, rule.action, rule.message ?? ''],
  );
}

/** Отправка запланированных действий в hh.ru */
export async function processHhActions(limit = 20): Promise<void> {
  const rows = await query<any>(
    `SELECT * FROM responses WHERE hh_action IS NOT NULL AND hh_action_next_at <= now() AND hh_action_attempts < $1
     ORDER BY hh_action_next_at LIMIT $2`,
    [config.worker.maxAttempts, limit],
  );
  for (const r of rows) {
    const label = (HH_ACTIONS as Record<string, string>)[r.hh_action] ?? r.hh_action;
    try {
      if (!r.hh_account_id) throw new Error('Аккаунт hh.ru отключён');
      const hh = await hhClientFor(r.hh_account_id);
      await applyNegotiationAction(hh, r.negotiation_id, r.hh_action, r.hh_action_message ?? '');
      await query(
        `UPDATE responses SET hh_last_action = hh_action, hh_action = NULL, hh_action_error = NULL WHERE id = $1`,
        [r.id],
      );
      await plog(r.portal_id, 'info', `hh.ru: «${label}» для ${r.candidate_name ?? 'кандидата'} (отклик ${r.negotiation_id})`);
    } catch (e) {
      const attempts = r.hh_action_attempts + 1;
      // «действие недоступно» повторять бессмысленно
      const permanent = /недоступно/.test(errText(e));
      await query(
        `UPDATE responses SET hh_action_attempts = $2, hh_action_error = $3,
           hh_action_next_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [r.id, permanent ? config.worker.maxAttempts : attempts, errText(e).slice(0, 1000), Math.min(2 ** attempts, 120)],
      );
      await plog(r.portal_id, 'error', `Не удалось выполнить «${label}» в hh.ru (отклик ${r.negotiation_id}): ${errText(e)}`);
    }
  }
}

/** Подписка на события изменения сделок и элементов смарт-процессов */
export async function bindEvents(portalId: number): Promise<void> {
  const portal = await getPortal(portalId);
  if (!portal) return;
  const b24 = new B24Client(portal);
  const handler = `${config.publicUrl}/b24/event`;
  const bound: any[] = await b24.call('event.get').catch(() => []);
  for (const event of ['ONCRMDEALUPDATE', 'ONCRMDYNAMICITEMUPDATE']) {
    if (bound.some((b) => b.event === event && b.handler === handler)) continue;
    try {
      await b24.call('event.bind', { event, handler });
    } catch (e) {
      if (!/already/i.test(errText(e))) throw e;
    }
  }
  await query('UPDATE portals SET events_bound = TRUE WHERE id = $1', [portalId]);
}
