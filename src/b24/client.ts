import { config } from '../config.js';
import { getPortal, saveTokens, type Portal } from '../portals.js';

export class B24Error extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(`Битрикс24: ${code}${message ? ' — ' + message : ''}`);
  }
}

/** Проверка, что домен похож на домен портала, а не на внутренний адрес (защита от SSRF) */
export function isValidPortalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return false;
  if (/^\d+(\.\d+){3}$/.test(d)) return false;
  if (d === 'localhost' || d.endsWith('.local') || d.endsWith('.internal') || d.endsWith('.localhost')) return false;
  return true;
}

// ---- простейший ограничитель частоты: не чаще ~2.5 запросов/сек на портал ----
const lastCall = new Map<number, Promise<void>>();
const MIN_GAP_MS = 400;
function throttle(portalId: number): Promise<void> {
  const prev = lastCall.get(portalId) ?? Promise.resolve();
  const next = prev.then(() => new Promise<void>((r) => setTimeout(r, MIN_GAP_MS)));
  lastCall.set(portalId, next);
  return prev;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Прямой вызов REST по токену (без обновления) — для проверки входящей авторизации */
export async function rawCall(domain: string, accessToken: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`https://${domain}/rest/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, auth: accessToken }),
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.error) throw new B24Error(data.error, data.error_description ?? '', res.status);
  if (!res.ok) throw new B24Error(String(res.status), res.statusText, res.status);
  return data;
}

/** Обновление OAuth-токенов портала через oauth.bitrix.info */
export async function refreshPortalTokens(portal: Portal): Promise<Portal> {
  if (!portal.clientId || !portal.clientSecret) {
    throw new B24Error('NO_CLIENT_CREDENTIALS', 'не заданы client_id/client_secret локального приложения (откройте приложение в портале)');
  }
  if (!portal.refreshToken) throw new B24Error('NO_REFRESH_TOKEN', 'нет refresh_token — переустановите приложение');
  const url = new URL(config.b24.oauthUrl);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('client_id', portal.clientId);
  url.searchParams.set('client_secret', portal.clientSecret);
  url.searchParams.set('refresh_token', portal.refreshToken);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new B24Error(data.error || 'REFRESH_FAILED', data.error_description || `HTTP ${res.status}`, res.status);
  }
  await saveTokens(portal.id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 3600,
    clientEndpoint: data.client_endpoint,
  });
  return (await getPortal(portal.id))!;
}

/** Клиент REST API конкретного портала с автообновлением токена и повторами */
export class B24Client {
  constructor(private portal: Portal) {}

  get domain() {
    return this.portal.domain;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.callRaw(method, params)).result as T;
  }

  async callRaw(method: string, params: Record<string, unknown> = {}, attempt = 0): Promise<any> {
    // токен истекает — обновляем заранее
    if (this.portal.expiresAt && this.portal.expiresAt.getTime() - Date.now() < 60_000 && this.portal.clientSecret) {
      this.portal = await refreshPortalTokens(this.portal);
    }
    await throttle(this.portal.id);
    const endpoint = this.portal.clientEndpoint.replace(/\/+$/, '/');
    let res: Response;
    try {
      res = await fetch(`${endpoint}${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, auth: this.portal.accessToken }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        return this.callRaw(method, params, attempt + 1);
      }
      throw e;
    }
    const data: any = await res.json().catch(() => ({}));
    if (data.error) {
      if ((data.error === 'expired_token' || data.error === 'invalid_token') && attempt < 1) {
        this.portal = await refreshPortalTokens(this.portal);
        return this.callRaw(method, params, attempt + 1);
      }
      if ((data.error === 'QUERY_LIMIT_EXCEEDED' || res.status === 503) && attempt < 4) {
        await sleep(1500 * (attempt + 1));
        return this.callRaw(method, params, attempt + 1);
      }
      throw new B24Error(data.error, data.error_description ?? '', res.status);
    }
    if (!res.ok) throw new B24Error(String(res.status), res.statusText, res.status);
    return data;
  }

  /** Постраничная выгрузка списков (start/next). Для crm.item.list результат в result.items */
  async listAll<T = any>(method: string, params: Record<string, unknown> = {}, pick?: (r: any) => T[], limit = 5000): Promise<T[]> {
    const out: T[] = [];
    let start: number | undefined = 0;
    while (start !== undefined && out.length < limit) {
      const data = await this.callRaw(method, { ...params, start });
      const items = pick ? pick(data.result) : (data.result as T[]);
      out.push(...(items ?? []));
      start = typeof data.next === 'number' ? data.next : undefined;
    }
    return out;
  }
}

export async function clientFor(portalId: number): Promise<B24Client> {
  const p = await getPortal(portalId);
  if (!p) throw new Error(`Портал ${portalId} не найден`);
  return new B24Client(p);
}
