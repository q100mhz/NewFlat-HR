import { query, queryOne } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { parseSettings, type Settings } from './settings.js';

export interface PortalRow {
  id: number;
  domain: string;
  member_id: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: Date | null;
  client_endpoint: string | null;
  settings: unknown;
  hh_client_id: string | null;
  hh_client_secret: string | null;
  events_bound: boolean;
}

export interface Portal {
  id: number;
  domain: string;
  memberId: string;
  clientId: string | null;
  clientSecret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  clientEndpoint: string;
  settings: Settings;
  hhClientId: string | null;
  hhClientSecret: string | null;
  eventsBound: boolean;
}

function map(r: PortalRow): Portal {
  return {
    id: r.id,
    domain: r.domain,
    memberId: r.member_id,
    clientId: r.client_id,
    clientSecret: decrypt(r.client_secret),
    accessToken: decrypt(r.access_token),
    refreshToken: decrypt(r.refresh_token),
    expiresAt: r.expires_at,
    clientEndpoint: r.client_endpoint || `https://${r.domain}/rest/`,
    settings: parseSettings(r.settings),
    hhClientId: r.hh_client_id,
    hhClientSecret: decrypt(r.hh_client_secret),
    eventsBound: r.events_bound,
  };
}

export async function getPortal(id: number): Promise<Portal | null> {
  const r = await queryOne<PortalRow>('SELECT * FROM portals WHERE id = $1', [id]);
  return r ? map(r) : null;
}

export async function getPortalByDomain(domain: string): Promise<Portal | null> {
  const r = await queryOne<PortalRow>('SELECT * FROM portals WHERE domain = $1', [domain.toLowerCase()]);
  return r ? map(r) : null;
}

export async function upsertPortalAuth(p: {
  domain: string;
  memberId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Promise<Portal> {
  const r = await queryOne<PortalRow>(
    `INSERT INTO portals (domain, member_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     ON CONFLICT (domain) DO UPDATE SET
       member_id = EXCLUDED.member_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()
     RETURNING *`,
    [p.domain.toLowerCase(), p.memberId, encrypt(p.accessToken), encrypt(p.refreshToken), p.expiresIn],
  );
  return map(r!);
}

export async function saveTokens(id: number, t: { accessToken: string; refreshToken: string; expiresIn: number; clientEndpoint?: string }) {
  await query(
    `UPDATE portals SET access_token = $2, refresh_token = $3, expires_at = now() + make_interval(secs => $4),
       client_endpoint = COALESCE($5, client_endpoint), updated_at = now() WHERE id = $1`,
    [id, encrypt(t.accessToken), encrypt(t.refreshToken), t.expiresIn, t.clientEndpoint ?? null],
  );
}

export async function saveClientCredentials(id: number, clientId: string, clientSecret: string) {
  await query('UPDATE portals SET client_id = $2, client_secret = $3, updated_at = now() WHERE id = $1', [
    id,
    clientId,
    encrypt(clientSecret),
  ]);
}

export async function saveHhCredentials(id: number, clientId: string | null, clientSecret: string | null) {
  await query('UPDATE portals SET hh_client_id = $2, hh_client_secret = $3, updated_at = now() WHERE id = $1', [
    id,
    clientId || null,
    clientId ? encrypt(clientSecret) : null,
  ]);
}

export async function saveSettings(id: number, s: Settings) {
  await query('UPDATE portals SET settings = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(s)]);
}

export async function setEventsBound(id: number, v: boolean) {
  await query('UPDATE portals SET events_bound = $2 WHERE id = $1', [id, v]);
}
