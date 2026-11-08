import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const encKey = createHash('sha256').update('enc:' + config.secretKey).digest();
const signKey = createHash('sha256').update('sign:' + config.secretKey).digest();

/** Шифрование AES-256-GCM. Формат: v1.<iv>.<tag>.<data> (base64url) */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  const [v, iv, tag, data] = value.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Неверный формат зашифрованного значения');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Подписанный токен (компактный аналог JWT) */
export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const mac = createHmac('sha256', signKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T = Record<string, unknown>>(token: string | undefined | null): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', signKey).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data as T;
  } catch {
    return null;
  }
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
