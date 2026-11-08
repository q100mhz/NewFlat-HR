import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Portal } from '../portals.js';

export class HhError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    const errs = Array.isArray(body?.errors) ? body.errors.map((e: any) => [e.type, e.value].filter(Boolean).join(':')).join(', ') : '';
    super(`hh.ru: HTTP ${status}${errs ? ' — ' + errs : body?.description ? ' — ' + body.description : ''}`);
  }
  hasError(value: string) {
    return Array.isArray(this.body?.errors) && this.body.errors.some((e: any) => e.value === value || e.type === value);
  }
}

export interface HhAccount {
  id: number;
  portalId: number;
  hhUserId: string;
  employerId: string;
  employerName: string | null;
  managerId: string | null;
  managerName: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  importSince: Date;
  active: boolean;
  lastPollAt: Date | null;
  lastError: string | null;
  lastSuccessAt: Date | null;
  lastFullScanAt: Date | null;
  catchupFrom: Date | null;
}

function mapAccount(r: any): HhAccount {
  return {
    id: r.id,
    portalId: r.portal_id,
    hhUserId: r.hh_user_id,
    employerId: r.employer_id,
    employerName: r.employer_name,
    managerId: r.manager_id,
    managerName: r.manager_name,
    accessToken: decrypt(r.access_token)!,
    refreshToken: decrypt(r.refresh_token)!,
    expiresAt: r.expires_at,
    importSince: r.import_since,
    active: r.active,
    lastPollAt: r.last_poll_at,
    lastError: r.last_error,
    lastSuccessAt: r.last_success_at ?? null,
    lastFullScanAt: r.last_full_scan_at ?? null,
    catchupFrom: r.catchup_from ?? null,
  };
}

export async function getAccount(id: number): Promise<HhAccount | null> {
  const r = await queryOne('SELECT * FROM hh_accounts WHERE id = $1', [id]);
  return r ? mapAccount(r) : null;
}

export async function listAccounts(portalId: number): Promise<HhAccount[]> {
  return (await query('SELECT * FROM hh_accounts WHERE portal_id = $1 ORDER BY id', [portalId])).map(mapAccount);
}

export async function upsertAccount(a: {
  portalId: number;
  hhUserId: string;
  employerId: string;
  employerName: string;
  managerId: string | null;
  managerName: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Promise<HhAccount> {
  const r = await queryOne(
    `INSERT INTO hh_accounts (portal_id, hh_user_id, employer_id, employer_name, manager_id, manager_name,
                              access_token, refresh_token, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))
     ON CONFLICT (portal_id, hh_user_id) DO UPDATE SET
       employer_id = EXCLUDED.employer_id, employer_name = EXCLUDED.employer_name,
       manager_id = EXCLUDED.manager_id, manager_name = EXCLUDED.manager_name,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at, active = TRUE, last_error = NULL, poll_requested = TRUE
     RETURNING *`,
    [a.portalId, a.hhUserId, a.employerId, a.employerName, a.managerId, a.managerName, encrypt(a.accessToken), encrypt(a.refreshToken), a.expiresIn],
  );
  return mapAccount(r);
}

/** Ключи приложения hh.ru: свои ключи портала либо общие ключи сервера */
export function hhCredentials(portal: Pick<Portal, 'hhClientId' | 'hhClientSecret'>) {
  if (portal.hhClientId && portal.hhClientSecret) return { clientId: portal.hhClientId, clientSecret: portal.hhClientSecret };
  if (config.hh.clientId && config.hh.clientSecret) return { clientId: config.hh.clientId, clientSecret: config.hh.clientSecret };
  return null;
}

function baseHeaders(): Record<string, string> {
  return { 'HH-User-Agent': config.hh.userAgent, 'User-Agent': config.hh.userAgent, Accept: 'application/json' };
}

/** Обмен кода авторизации на токены */
export async function exchangeCode(code: string, creds: { clientId: string; clientSecret: string }, redirectUri: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(config.hh.tokenUrl, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new HhError(res.status, data);
  return data as { access_token: string; refresh_token: string; expires_in: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Клиент API hh.ru от имени подключённого менеджера, с обновлением токена */
export class HhClient {
  constructor(private account: HhAccount) {}

  get accountId() {
    return this.account.id;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(config.hh.tokenUrl, {
      method: 'POST',
      headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.account.refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const err = new HhError(res.status, data);
      await query('UPDATE hh_accounts SET last_error = $2 WHERE id = $1', [this.account.id, 'Не удалось обновить токен hh.ru: ' + err.message]);
      throw err;
    }
    await query(
      `UPDATE hh_accounts SET access_token = $2, refresh_token = $3, expires_at = now() + make_interval(secs => $4), last_error = NULL WHERE id = $1`,
      [this.account.id, encrypt(data.access_token), encrypt(data.refresh_token), Number(data.expires_in) || 1209600],
    );
    this.account.accessToken = data.access_token;
    this.account.refreshToken = data.refresh_token;
  }

  private url(pathOrUrl: string, params?: Record<string, string | number | undefined>) {
    const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : config.hh.apiUrl + pathOrUrl);
    // защита: токен отправляем только на api.hh.ru
    if (u.hostname !== new URL(config.hh.apiUrl).hostname) throw new Error(`Недопустимый адрес hh.ru: ${u.hostname}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  async request(
    method: string,
    pathOrUrl: string,
    opts: { params?: Record<string, string | number | undefined>; form?: Record<string, string>; json?: unknown; raw?: boolean } = {},
    attempt = 0,
  ): Promise<any> {
    const headers: Record<string, string> = { ...baseHeaders(), Authorization: `Bearer ${this.account.accessToken}` };
    let body: BodyInit | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form);
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (opts.raw) headers.Accept = '*/*';
    const res = await fetch(this.url(pathOrUrl, opts.params), { method, headers, body, signal: AbortSignal.timeout(60000) });

    if (res.ok) {
      if (opts.raw) return Buffer.from(await res.arrayBuffer());
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const data: any = await res.json().catch(() => ({}));
    const err = new HhError(res.status, data);
    if ((res.status === 401 || res.status === 403) && err.hasError('token_expired') && attempt < 1) {
      await this.refresh();
      return this.request(method, pathOrUrl, opts, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return this.request(method, pathOrUrl, opts, attempt + 1);
    }
    throw err;
  }

  get = (path: string, params?: Record<string, string | number | undefined>) => this.request('GET', path, { params });
}

export async function hhClientFor(accountId: number): Promise<HhClient> {
  const a = await getAccount(accountId);
  if (!a) throw new Error(`Аккаунт hh.ru ${accountId} не найден`);
  return new HhClient(a);
}
