import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { verify } from '../crypto.js';
import { query } from '../db.js';
import { B24Client, refreshPortalTokens } from '../b24/client.js';
import { getPortal, saveClientCredentials, saveHhCredentials, saveSettings } from '../portals.js';
import { HH_ACTIONS, HH_FIELDS, settingsSchema } from '../settings.js';
import { getAccount, HhClient, hhCredentials, listAccounts } from '../hh/client.js';
import { cachedVacancies } from '../sync/poller.js';
import { bindEvents } from '../sync/backsync.js';
import { tick } from '../sync/worker.js';
import { errText, plog } from '../log.js';
import type { Session } from './b24.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function session(req: FastifyRequest, admin = false): Session {
  const h = req.headers.authorization ?? '';
  const s = verify<Session>(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!s) throw new HttpError(401, 'Сессия истекла — обновите страницу приложения');
  if (admin && !s.adm) throw new HttpError(403, 'Изменять настройки может только администратор портала');
  return s;
}

const MAPPABLE_TYPES = new Set(['string', 'integer', 'double', 'money', 'date', 'datetime', 'url']);

function stageEntityId(entityTypeId: number, categoryId: number) {
  if (entityTypeId === 2) return categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
  return `DYNAMIC_${entityTypeId}_STAGE_${categoryId}`;
}

export async function apiRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) console.error(err);
    reply.status(status).send({ error: err.message || 'Ошибка' });
  });

  async function portalOf(s: Session) {
    const p = await getPortal(s.pid);
    if (!p) throw new HttpError(404, 'Портал не найден');
    return p;
  }

  // Общее состояние для экрана настроек
  app.get('/api/state', async (req) => {
    const s = session(req);
    const p = await portalOf(s);
    const accounts = (await listAccounts(p.id)).map((a) => ({
      id: a.id,
      employerName: a.employerName,
      managerName: a.managerName,
      active: a.active,
      importSince: a.importSince,
      lastPollAt: a.lastPollAt,
      lastError: a.lastError,
    }));
    const [stats] = await query(
      `SELECT count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              count(*) FILTER (WHERE status = 'done' AND imported_at > now() - interval '1 day')::int AS today
       FROM responses WHERE portal_id = $1`,
      [p.id],
    );
    return {
      domain: p.domain,
      isAdmin: s.adm,
      hasB24Credentials: Boolean(p.clientId && p.clientSecret),
      b24ClientId: p.clientId,
      settings: p.settings,
      accounts,
      stats,
      eventsBound: p.eventsBound,
      hh: {
        ownCredentials: Boolean(p.hhClientId),
        ownClientId: p.hhClientId,
        serverCredentials: Boolean(config.hh.clientId && config.hh.clientSecret),
        available: Boolean(hhCredentials(p)),
        redirectUri: config.hh.redirectUri,
      },
      dictionaries: { hhFields: HH_FIELDS, hhActions: HH_ACTIONS },
      publicUrl: config.publicUrl,
    };
  });

  // client_id / client_secret локального приложения — нужны для фоновой работы
  app.post('/api/b24-credentials', async (req) => {
    const s = session(req, true);
    const { clientId, clientSecret } = (req.body ?? {}) as Record<string, string>;
    if (!clientId?.trim() || !clientSecret?.trim()) throw new HttpError(400, 'Укажите client_id и client_secret');
    const before = await portalOf(s);
    await saveClientCredentials(s.pid, clientId.trim(), clientSecret.trim());
    try {
      await refreshPortalTokens((await getPortal(s.pid))!);
    } catch (e) {
      if (before.clientId) await saveClientCredentials(s.pid, before.clientId, before.clientSecret ?? '');
      else await query('UPDATE portals SET client_id = NULL, client_secret = NULL WHERE id = $1', [s.pid]);
      throw new HttpError(400, `Ключи не подошли: ${errText(e)}`);
    }
    await plog(s.pid, 'info', 'Сохранены ключи локального приложения Битрикс24');
    return { ok: true };
  });

  // Справочники Битрикс24: смарт-процессы, воронки, пользователи, источники, поля
  app.get('/api/b24/meta', async (req) => {
    const s = session(req);
    const b24 = new B24Client(await portalOf(s));
    const entityTypeId = Number((req.query as any).entityTypeId) || 2;
    const [types, categories, users, sources, fields] = await Promise.all([
      b24.call('crm.type.list').then((r: any) => r?.types ?? []).catch(() => []),
      b24.call('crm.category.list', { entityTypeId }).then((r: any) => r?.categories ?? []),
      b24.listAll('user.get', { FILTER: { ACTIVE: true, USER_TYPE: 'employee' } }),
      b24.call('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } }).catch(() => []),
      b24.call('crm.item.fields', { entityTypeId }).then((r: any) => r?.fields ?? {}),
    ]);
    return {
      entityTypes: [{ id: 2, title: 'Сделки' }, ...types.map((t: any) => ({ id: t.entityTypeId, title: `Смарт-процесс: ${t.title}` }))],
      categories: categories.map((c: any) => ({ id: Number(c.id), name: c.name })),
      users: users.map((u: any) => ({ id: Number(u.ID), name: [u.LAST_NAME, u.NAME].filter(Boolean).join(' ') || u.EMAIL || `#${u.ID}` })),
      sources: (sources as any[]).map((x) => ({ id: x.STATUS_ID, name: x.NAME })),
      fields: Object.entries(fields as Record<string, any>)
        .filter(([, f]) => !f.isReadOnly && MAPPABLE_TYPES.has(f.type))
        .map(([id, f]) => ({ id, title: f.title || id, type: f.type, custom: id.startsWith('ufCrm') || id.startsWith('uf') })),
    };
  });

  app.get('/api/b24/stages', async (req) => {
    const s = session(req);
    const b24 = new B24Client(await portalOf(s));
    const q = req.query as any;
    const entityTypeId = Number(q.entityTypeId) || 2;
    const categoryId = Number(q.categoryId) || 0;
    const list: any[] = await b24.call('crm.status.list', {
      order: { SORT: 'ASC' },
      filter: { ENTITY_ID: stageEntityId(entityTypeId, categoryId) },
    });
    return list.map((x) => ({ id: x.STATUS_ID, name: x.NAME, semantics: x.EXTRA?.SEMANTICS ?? null }));
  });

  // Активные вакансии всех подключённых аккаунтов
  app.get('/api/hh/vacancies', async (req) => {
    const s = session(req);
    const out: any[] = [];
    for (const acc of await listAccounts(s.pid)) {
      if (!acc.active) continue;
      try {
        const items = await cachedVacancies(new HhClient(acc), acc, (req.query as any).force === '1');
        out.push(...items.map((v) => ({ ...v, account: acc.managerName || acc.employerName })));
      } catch (e) {
        out.push({ error: `${acc.managerName}: ${errText(e)}` });
      }
    }
    return out;
  });

  app.post('/api/settings', async (req) => {
    const s = session(req, true);
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Некорректные настройки: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
    const p = await portalOf(s);
    if (parsed.data.enabled && !p.clientSecret) throw new HttpError(400, 'Сначала укажите ключи локального приложения Битрикс24 (вкладка «Подключение»)');
    await saveSettings(s.pid, parsed.data);
    if (parsed.data.hhSync.enabled && !p.eventsBound) {
      try {
        await bindEvents(s.pid);
      } catch (e) {
        throw new HttpError(400, `Настройки сохранены, но не удалось подписаться на события Битрикс24: ${errText(e)}`);
      }
    }
    await query('UPDATE hh_accounts SET poll_requested = TRUE WHERE portal_id = $1', [s.pid]);
    await plog(s.pid, 'info', 'Настройки сохранены');
    return { ok: true };
  });

  // Собственные ключи приложения hh.ru для портала (необязательно)
  app.post('/api/hh/credentials', async (req) => {
    const s = session(req, true);
    const { clientId, clientSecret } = (req.body ?? {}) as Record<string, string>;
    if (clientId && !clientSecret) throw new HttpError(400, 'Укажите client_secret');
    await saveHhCredentials(s.pid, clientId?.trim() || null, clientSecret?.trim() || null);
    return { ok: true };
  });

  app.post('/api/hh/accounts/:id', async (req) => {
    const s = session(req, true);
    const acc = await getAccount(Number((req.params as any).id));
    if (!acc || acc.portalId !== s.pid) throw new HttpError(404, 'Аккаунт не найден');
    const b = (req.body ?? {}) as { importSince?: string; active?: boolean };
    if (b.importSince) {
      const d = new Date(b.importSince);
      if (isNaN(d.getTime())) throw new HttpError(400, 'Некорректная дата');
      await query('UPDATE hh_accounts SET import_since = $2, poll_requested = TRUE WHERE id = $1', [acc.id, d]);
    }
    if (typeof b.active === 'boolean') await query('UPDATE hh_accounts SET active = $2 WHERE id = $1', [acc.id, b.active]);
    return { ok: true };
  });

  app.delete('/api/hh/accounts/:id', async (req) => {
    const s = session(req, true);
    const rows = await query('DELETE FROM hh_accounts WHERE id = $1 AND portal_id = $2 RETURNING manager_name', [Number((req.params as any).id), s.pid]);
    if (rows.length) await plog(s.pid, 'info', `Отключён аккаунт hh.ru: ${rows[0].manager_name}`);
    return { ok: true };
  });

  app.post('/api/sync-now', async (req) => {
    const s = session(req, true);
    await query('UPDATE hh_accounts SET poll_requested = TRUE WHERE portal_id = $1', [s.pid]);
    setImmediate(() => tick());
    return { ok: true };
  });

  app.post('/api/retry-errors', async (req) => {
    const s = session(req, true);
    const rows = await query(
      `UPDATE responses SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE portal_id = $1 AND status = 'error' RETURNING id`,
      [s.pid],
    );
    await query(
      `UPDATE responses SET hh_action_attempts = 0, hh_action_next_at = now() WHERE portal_id = $1 AND hh_action IS NOT NULL`,
      [s.pid],
    );
    setImmediate(() => tick());
    return { ok: true, count: rows.length };
  });

  app.get('/api/responses', async (req) => {
    const s = session(req);
    return query(
      `SELECT id, negotiation_id, vacancy_name, candidate_name, status, attempts, last_error, b24_item_id, b24_entity_type_id,
              is_repeat, hh_created_at, imported_at, hh_last_action, hh_action, hh_action_error
       FROM responses WHERE portal_id = $1 ORDER BY id DESC LIMIT 100`,
      [s.pid],
    );
  });

  app.get('/api/logs', async (req) => {
    const s = session(req);
    return query('SELECT id, level, message, created_at FROM logs WHERE portal_id = $1 ORDER BY id DESC LIMIT 200', [s.pid]);
  });
}
