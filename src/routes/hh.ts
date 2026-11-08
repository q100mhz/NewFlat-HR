import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { randomId, sign, verify } from '../crypto.js';
import { query } from '../db.js';
import { getPortal } from '../portals.js';
import { exchangeCode, hhCredentials, HhClient, upsertAccount } from '../hh/client.js';
import { subscribeWebhook } from '../hh/api.js';
import { errText, plog } from '../log.js';
import { messagePage } from '../views.js';
import type { Session } from './b24.js';
import { tick } from '../sync/worker.js';

const redirectUri = () => config.hh.redirectUri;

export async function hhRoutes(app: FastifyInstance) {
  // Начало подключения аккаунта hh.ru (открывается во всплывающем окне)
  app.get('/hh/connect', async (req, reply) => {
    const s = verify<Session>((req.query as any)?.s);
    if (!s || !s.adm) return reply.type('text/html').send(messagePage('Нет доступа', 'Сессия истекла или нет прав администратора. Откройте приложение заново.', { ok: false }));
    const portal = await getPortal(s.pid);
    const creds = portal && hhCredentials(portal);
    if (!creds) return reply.type('text/html').send(messagePage('Не настроено', 'Не заданы ключи приложения hh.ru (HH_CLIENT_ID / HH_CLIENT_SECRET).', { ok: false }));
    const state = sign({ pid: s.pid, n: randomId(8) }, 15 * 60);
    const url = new URL(config.hh.oauthUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri());
    return reply.redirect(url.toString());
  });

  // Возврат с hh.ru после авторизации. Обрабатываем и /hh/callback, и корень домена
  // (если на dev.hh.ru redirect URI указан просто как https://домен).
  app.get('/', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.state || q.code || q.error) return callback(req, reply);
    return reply.type('text/html').send('<h3>HH → Битрикс24 коннектор работает</h3>');
  });
  app.get('/hh/callback', (req, reply) => callback(req, reply));

  async function callback(req: FastifyRequest, reply: FastifyReply) {
    const q = (req.query ?? {}) as Record<string, string>;
    const st = verify<{ pid: number }>(q.state);
    const page = (title: string, text: string, ok = true) =>
      reply.type('text/html').send(
        messagePage(title, text, {
          ok,
          script: `try { window.opener && window.opener.postMessage({ type: 'hh-connected', ok: ${ok} }, '*'); } catch(e) {}
                   ${ok ? 'setTimeout(function(){ window.close(); }, 1500);' : ''}`,
        }),
      );
    if (!st) return page('Ошибка', 'Ссылка устарела. Повторите подключение из приложения.', false);
    if (q.error) return page('Подключение отменено', q.error_description || q.error, false);
    try {
      const portal = await getPortal(st.pid);
      const creds = portal && hhCredentials(portal);
      if (!portal || !creds) throw new Error('Портал или ключи hh.ru не найдены');
      const tok = await exchangeCode(q.code, creds, redirectUri());
      const tmp = new HhClient({ accessToken: tok.access_token, refreshToken: tok.refresh_token } as any);
      const me = await tmp.get('/me');
      if (!me?.is_employer || !me?.employer?.id) {
        throw new Error('Это не аккаунт работодателя. Войдите на hh.ru под учётной записью компании (менеджера).');
      }
      const account = await upsertAccount({
        portalId: portal.id,
        hhUserId: String(me.id),
        employerId: String(me.employer.id),
        employerName: me.employer.name ?? '',
        managerId: me.employer.manager_id ? String(me.employer.manager_id) : null,
        managerName: [me.last_name, me.first_name].filter(Boolean).join(' '),
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresIn: tok.expires_in,
      });
      await plog(portal.id, 'info', `Подключён аккаунт hh.ru: ${account.managerName} (${account.employerName})`);
      try {
        const wid = await subscribeWebhook(new HhClient(account));
        if (wid) await query('UPDATE hh_accounts SET webhook_id = $2 WHERE id = $1', [account.id, wid]);
      } catch (e) {
        await plog(portal.id, 'warn', `Вебхук hh.ru не подключён, работает опрос по расписанию: ${errText(e)}`);
      }
      return page('hh.ru подключён', `Аккаунт ${account.managerName} (${account.employerName}) подключён. Окно закроется автоматически.`);
    } catch (e) {
      return page('Ошибка подключения', errText(e), false);
    }
  }

  // Вебхук hh.ru: просто ускоряем опрос соответствующего аккаунта
  app.post('/hh/webhook', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const userId = b.user_id ? String(b.user_id) : null;
    const employerId = b.payload?.employer_id ? String(b.payload.employer_id) : null;
    if (userId || employerId) {
      const rows = await query(
        `UPDATE hh_accounts SET poll_requested = TRUE WHERE active AND (hh_user_id = $1 OR employer_id = $2) RETURNING id`,
        [userId, employerId],
      );
      if (rows.length) setImmediate(() => tick());
    }
    return reply.send({ ok: true });
  });
}
