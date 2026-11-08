import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sign } from '../crypto.js';
import { isValidPortalDomain, rawCall } from '../b24/client.js';
import { getPortalByDomain, upsertPortalAuth, type Portal } from '../portals.js';
import { onItemUpdated } from '../sync/backsync.js';
import { errText, plog } from '../log.js';
import { messagePage, render, safeJson } from '../views.js';

export interface Session {
  pid: number;
  uid: number;
  adm: boolean;
  dom: string;
}

/** Параметры, которые Битрикс24 передаёт при открытии приложения во фрейме */
function readAuth(req: FastifyRequest) {
  const q = (req.query ?? {}) as Record<string, string>;
  const b = (req.body ?? {}) as Record<string, string>;
  return {
    domain: String(q.DOMAIN || b.DOMAIN || '').toLowerCase().replace(/:\d+$/, ''),
    authId: String(b.AUTH_ID || ''),
    refreshId: String(b.REFRESH_ID || ''),
    expires: Number(b.AUTH_EXPIRES || 3600),
    memberId: String(b.member_id || ''),
  };
}

/**
 * Проверяем авторизацию «по-честному»: вызываем REST портала с переданным токеном.
 * Подделать ответ можно только для своего же домена.
 */
async function authenticate(req: FastifyRequest) {
  const a = readAuth(req);
  if (!a.domain || !a.authId || !a.memberId) throw new Error('Приложение нужно открывать из Битрикс24');
  if (!isValidPortalDomain(a.domain)) throw new Error('Некорректный домен портала');
  if (config.allowedPortals.length && !config.allowedPortals.includes(a.domain)) {
    throw new Error(`Портал ${a.domain} не подключён к этому серверу. Обратитесь к поставщику интеграции.`);
  }
  const user = (await rawCall(a.domain, a.authId, 'user.current')).result;
  const isAdmin = Boolean((await rawCall(a.domain, a.authId, 'user.admin')).result);
  const existing = await getPortalByDomain(a.domain);
  if (existing && existing.memberId !== a.memberId) {
    throw new Error('member_id портала не совпадает с сохранённым. Если портал переустановлен — обратитесь к поставщику.');
  }
  return { ...a, user, isAdmin, existing };
}

async function storeAuth(a: Awaited<ReturnType<typeof authenticate>>): Promise<Portal> {
  // Токены для фоновой работы сохраняем только от администратора (у него полные права на CRM)
  if (a.isAdmin || !a.existing) {
    return upsertPortalAuth({
      domain: a.domain,
      memberId: a.memberId,
      accessToken: a.authId,
      refreshToken: a.refreshId,
      expiresIn: a.expires,
    });
  }
  return a.existing!;
}

function errorPage(reply: FastifyReply, e: unknown) {
  return reply.type('text/html').send(messagePage('Ошибка', errText(e), { ok: false }));
}

export async function b24Routes(app: FastifyInstance) {
  // Установка локального приложения
  const install = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const a = await authenticate(req);
      if (!a.isAdmin) throw new Error('Установить приложение может только администратор портала');
      const portal = await storeAuth(a);
      await plog(portal.id, 'info', `Приложение установлено (${a.domain}), пользователь ${a.user?.NAME ?? ''} ${a.user?.LAST_NAME ?? ''}`);
      return reply.type('text/html').send(
        messagePage('Приложение установлено', 'Откройте приложение, чтобы завершить настройку.', {
          script: `BX24.init(function(){ BX24.installFinish(); });`,
        }),
      );
    } catch (e) {
      return errorPage(reply, e);
    }
  };
  app.post('/b24/install', install);
  app.get('/b24/install', install);

  // Открытие приложения — экран настроек
  const open = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const a = await authenticate(req);
      const portal = await storeAuth(a);
      const session: Session = { pid: portal.id, uid: Number(a.user?.ID), adm: a.isAdmin, dom: portal.domain };
      const token = sign(session as unknown as Record<string, unknown>, 12 * 3600);
      return reply.type('text/html').send(
        render('app.html', {
          boot: safeJson({
            token,
            domain: portal.domain,
            isAdmin: a.isAdmin,
            userName: [a.user?.NAME, a.user?.LAST_NAME].filter(Boolean).join(' '),
          }),
        }),
      );
    } catch (e) {
      return errorPage(reply, e);
    }
  };
  app.post('/b24/app', open);
  app.get('/b24/app', open);

  // События CRM (изменение карточки) — для обратной синхронизации в hh.ru
  app.post('/b24/event', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const domain = String(b['auth[domain]'] || '').toLowerCase();
    const event = String(b.event || '').toUpperCase();
    const id = Number(b['data[FIELDS][ID]']);
    reply.send({ ok: true });
    if (!domain || !id) return;
    const portal = await getPortalByDomain(domain);
    if (!portal || portal.memberId !== String(b['auth[member_id]'] || '')) return;
    let entityTypeId = 2;
    if (event === 'ONCRMDYNAMICITEMUPDATE') entityTypeId = Number(b['data[FIELDS][ENTITY_TYPE_ID]']);
    else if (event !== 'ONCRMDEALUPDATE') return;
    if (!entityTypeId) return;
    onItemUpdated(portal.id, entityTypeId, id).catch((e) =>
      plog(portal.id, 'error', `Ошибка обработки изменения карточки ${id}: ${errText(e)}`),
    );
  });
}
