import { query, queryOne } from '../db.js';
import { B24Client, B24Error } from '../b24/client.js';
import { hhClientFor } from '../hh/client.js';
import { downloadResumePdf, extractCandidate, getCoverLetter, getResume, plural, type Candidate } from '../hh/api.js';
import { getPortal } from '../portals.js';
import { HH_FIELDS, isConfigured, type HhFieldKey, type Settings } from '../settings.js';
import { errText, plog } from '../log.js';

export interface ResponseRow {
  id: number;
  portal_id: number;
  hh_account_id: number | null;
  negotiation_id: string;
  vacancy_id: string | null;
  vacancy_name: string | null;
  raw: any;
  hh_created_at: Date | null;
  status: string;
  attempts: number;
  b24_item_id: string | null;
  b24_contact_id: string | null;
  is_repeat: boolean;
  via_catchup?: boolean;
  candidate_name?: string | null;
  step: string | null;
}

// ---------- поля сущности (кешируем на 10 минут) ----------
const fieldsCache = new Map<string, { at: number; fields: Record<string, any> }>();
export async function getItemFields(b24: B24Client, portalId: number, entityTypeId: number): Promise<Record<string, any>> {
  const key = `${portalId}:${entityTypeId}`;
  const c = fieldsCache.get(key);
  if (c && Date.now() - c.at < 600_000) return c.fields;
  const res = await b24.call('crm.item.fields', { entityTypeId });
  const fields = res?.fields ?? {};
  fieldsCache.set(key, { at: Date.now(), fields });
  return fields;
}

/** Значения данных hh.ru для маппинга */
export function hhValues(c: Candidate, ctx: { vacancyName: string; vacancyId: string; negotiationId: string; coverLetter: string; respondedAt: Date | null }) {
  const v: Record<HhFieldKey, string | number | null> = {
    vacancyName: ctx.vacancyName,
    vacancyId: ctx.vacancyId,
    vacancyUrl: ctx.vacancyId ? `https://hh.ru/vacancy/${ctx.vacancyId}` : '',
    resumeUrl: c.resumeUrl,
    position: c.position,
    city: c.city,
    age: c.age,
    birthDate: c.birthDate,
    gender: c.gender,
    salary: c.salary,
    salaryText: c.salaryText,
    experienceText: c.experienceText,
    experienceMonths: c.experienceMonths,
    phone: c.phones.join(', '),
    email: c.emails.join(', '),
    coverLetter: ctx.coverLetter,
    negotiationId: ctx.negotiationId,
    respondedAt: ctx.respondedAt ? ctx.respondedAt.toISOString() : null,
  };
  return v;
}

/** Приводит значение к типу поля Битрикс24 */
export function convertValue(value: string | number | null, field: any, currency = 'RUB'): unknown {
  if (value === null || value === '' || value === undefined) return undefined;
  const type = field?.type ?? 'string';
  let out: unknown;
  switch (type) {
    case 'integer':
    case 'double': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
      out = Number.isFinite(n) ? n : undefined;
      break;
    }
    case 'money': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.]/g, ''));
      out = Number.isFinite(n) ? `${n}|${currency === 'RUR' ? 'RUB' : currency || 'RUB'}` : undefined;
      break;
    }
    case 'date':
    case 'datetime':
      out = String(value);
      break;
    case 'boolean':
    case 'enumeration':
    case 'file':
    case 'crm_status':
    case 'crm_entity':
    case 'user':
      out = undefined; // такие типы не заполняем автоматически
      break;
    default:
      out = String(value);
  }
  if (out !== undefined && field?.isMultiple) return [out];
  return out;
}

export function renderTitle(s: Settings, c: Candidate, vacancyName: string, isRepeat: boolean): string {
  const title = (s.titleTemplate || '{vacancy} — {name}')
    .replaceAll('{vacancy}', vacancyName || 'Вакансия')
    .replaceAll('{name}', c.fullName)
    .replaceAll('{position}', c.position)
    .replaceAll('{city}', c.city)
    .replace(/\s+/g, ' ')
    .trim();
  const full = isRepeat ? `${s.repeatPrefix || 'Повторный отклик'}: ${title}` : title;
  return full.slice(0, 255);
}

async function findContact(b24: B24Client, c: Candidate): Promise<number | null> {
  const tryFind = async (type: 'PHONE' | 'EMAIL', values: string[]) => {
    if (!values.length) return null;
    const res = await b24.call('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type, values: values.slice(0, 20) });
    const ids: number[] = Array.isArray(res?.CONTACT) ? res.CONTACT : [];
    return ids.length ? Math.min(...ids.map(Number)) : null;
  };
  return (await tryFind('PHONE', c.phones)) ?? (await tryFind('EMAIL', c.emails));
}

async function createContact(b24: B24Client, s: Settings, c: Candidate, assignedById: number | null): Promise<number> {
  const fields: Record<string, unknown> = {
    NAME: c.firstName || c.fullName,
    LAST_NAME: c.lastName,
    SECOND_NAME: c.middleName,
    PHONE: c.phones.map((v) => ({ VALUE: v, VALUE_TYPE: 'MOBILE' })),
    EMAIL: c.emails.map((v) => ({ VALUE: v, VALUE_TYPE: 'WORK' })),
    COMMENTS: [c.position, c.city].filter(Boolean).join(', '),
    OPENED: 'Y',
  };
  if (c.birthDate) fields.BIRTHDATE = c.birthDate;
  if (assignedById) fields.ASSIGNED_BY_ID = assignedById;
  if (s.sourceId) fields.SOURCE_ID = s.sourceId;
  const id = await b24.call('crm.contact.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } });
  return Number(id);
}

function bb(s: string) {
  return s.replace(/\[/g, '(').replace(/\]/g, ')');
}

function timelineText(c: Candidate, vacancyName: string, coverLetter: string, isRepeat: boolean, delayed: boolean, respondedAt: Date | null): string {
  const lines = [
    `[B]Отклик с hh.ru${isRepeat ? ' (повторный)' : ''}[/B]`,
    delayed && `[I]Отклик поступил во время сбоя интеграции и догружен автоматически${respondedAt ? ` (дата отклика: ${respondedAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК)` : ''}[/I]`,
    `Вакансия: ${bb(vacancyName)}`,
    `Кандидат: ${bb(c.fullName)}${c.age ? `, ${c.age} ${plural(c.age, ['год', 'года', 'лет'])}` : ''}`,
    c.position && `Желаемая должность: ${bb(c.position)}`,
    c.city && `Город: ${bb(c.city)}`,
    c.salaryText && `Зарплата: ${c.salaryText}`,
    c.experienceText && `Опыт: ${c.experienceText}`,
    c.phones.length ? `Телефон: ${c.phones.join(', ')}` : '',
    c.emails.length ? `Email: ${c.emails.join(', ')}` : '',
    c.resumeUrl && `Резюме: [URL=${c.resumeUrl}]открыть на hh.ru[/URL]`,
    coverLetter && `\n[B]Сопроводительное письмо:[/B]\n${bb(coverLetter)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function setStep(id: number, step: string, extra: Record<string, unknown> = {}) {
  const keys = Object.keys(extra);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await query(`UPDATE responses SET step = $2${sets ? ', ' + sets : ''} WHERE id = $1`, [id, step, ...keys.map((k) => extra[k])]);
}

/** Импорт одного отклика в Битрикс24. Шаги идемпотентны: при повторе пропускаются выполненные. */
export async function importResponse(row: ResponseRow): Promise<void> {
  const portal = await getPortal(row.portal_id);
  if (!portal) throw new Error('Портал удалён');
  const s = portal.settings;
  if (!isConfigured(s)) throw new Error('Интеграция выключена или не настроена воронка/стадия');
  if (!row.hh_account_id) throw new Error('Аккаунт hh.ru отключён');

  const hh = await hhClientFor(row.hh_account_id);
  const b24 = new B24Client(portal);
  const neg = row.raw ?? {};

  const resume = await getResume(hh, neg);
  const candidate = extractCandidate(resume, neg);
  const coverLetter = await getCoverLetter(hh, row.negotiation_id);
  const vacancyId = row.vacancy_id ?? String(neg?.vacancy?.id ?? '');
  const vacancyName = row.vacancy_name ?? neg?.vacancy?.name ?? '';
  const assignedById = s.vacancies[vacancyId]?.assignedById ?? s.defaultAssignedById ?? null;

  await query('UPDATE responses SET candidate_name = $2, resume_id = $3 WHERE id = $1', [row.id, candidate.fullName, resume?.id ?? null]);

  // 1. Контакт (поиск дубля по телефону/email)
  let contactId = row.b24_contact_id ? Number(row.b24_contact_id) : null;
  let isRepeat = row.is_repeat;
  if (!contactId) {
    const existing = await findContact(b24, candidate);
    if (existing) {
      contactId = existing;
      isRepeat = true;
    } else {
      contactId = await createContact(b24, s, candidate, assignedById);
    }
    await setStep(row.id, 'contact', { b24_contact_id: contactId, is_repeat: isRepeat });
  }

  // 2. Карточка в воронке
  let itemId = row.b24_item_id ? Number(row.b24_item_id) : null;
  if (!itemId) {
    const fields: Record<string, unknown> = {
      title: renderTitle(s, candidate, vacancyName, isRepeat),
      categoryId: s.categoryId,
      stageId: s.stageId,
      contactId,
      contactIds: [contactId],
      opened: 'Y',
    };
    if (assignedById) fields.assignedById = assignedById;
    if (s.sourceId) fields.sourceId = s.sourceId;
    if (s.entityTypeId === 2) fields.sourceDescription = `hh.ru, отклик ${row.negotiation_id}`;

    const meta = await getItemFields(b24, portal.id, s.entityTypeId);
    const values = hhValues(candidate, {
      vacancyName,
      vacancyId,
      negotiationId: row.negotiation_id,
      coverLetter,
      respondedAt: row.hh_created_at,
    });
    for (const [hhKey, b24Field] of Object.entries(s.fieldMapping)) {
      if (!b24Field || !(hhKey in HH_FIELDS) || !meta[b24Field]) continue;
      const v = convertValue(values[hhKey as HhFieldKey], meta[b24Field], candidate.salaryCurrency);
      if (v !== undefined) fields[b24Field] = v;
    }

    const res = await b24.call('crm.item.add', { entityTypeId: s.entityTypeId, fields });
    itemId = Number(res?.item?.id);
    if (!itemId) throw new Error('Битрикс24 не вернул ID созданной карточки');
    await setStep(row.id, 'item', {
      b24_item_id: itemId,
      b24_entity_type_id: s.entityTypeId,
      b24_stage_id: s.stageId,
    });
  }

  // 3. Комментарий в таймлайне + PDF резюме
  if (row.step !== 'comment' && (s.timelineComment || s.attachPdf)) {
    const files: [string, string][] = [];
    if (s.attachPdf) {
      try {
        const pdf = await downloadResumePdf(hh, resume);
        if (pdf) files.push([pdf.name, pdf.data.toString('base64')]);
      } catch (e) {
        await plog(portal.id, 'warn', `Не удалось скачать PDF резюме (отклик ${row.negotiation_id}): ${errText(e)}`);
      }
    }
    const entityType = s.entityTypeId === 2 ? 'deal' : `dynamic_${s.entityTypeId}`;
    const text = s.timelineComment ? timelineText(candidate, vacancyName, coverLetter, isRepeat, Boolean(row.via_catchup), row.hh_created_at) : 'Резюме кандидата с hh.ru';
    if (s.timelineComment || files.length) {
      const fields: Record<string, unknown> = { ENTITY_ID: itemId, ENTITY_TYPE: entityType, COMMENT: text };
      if (files.length) fields.FILES = files;
      await b24.call('crm.timeline.comment.add', { fields });
    }
    await setStep(row.id, 'comment');
  }

  await query(`UPDATE responses SET status = 'done', imported_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
  await plog(portal.id, 'info', `Отклик загружен: ${candidate.fullName} → «${vacancyName}»${isRepeat ? ' (повторный)' : ''}`, {
    negotiationId: row.negotiation_id,
    itemId,
    contactId,
  });
}

/**
 * Обработка очереди откликов.
 * Ошибки повторяются БЕЗ ограничения числа попыток (интервал растёт до 30 минут):
 * когда Битрикс24 или hh.ru снова станут доступны, всё накопившееся загрузится само.
 */
export async function processQueue(limit = 20): Promise<number> {
  const rows = await query<ResponseRow>(
    `SELECT * FROM responses
     WHERE status IN ('pending','error') AND next_attempt_at <= now()
     ORDER BY next_attempt_at, id LIMIT $1`,
    [limit],
  );
  // если портал недоступен — не мучаем остальные его отклики в этом цикле
  const brokenPortals = new Set<number>();
  for (const row of rows) {
    if (brokenPortals.has(row.portal_id)) {
      await query(`UPDATE responses SET next_attempt_at = now() + interval '5 minutes' WHERE id = $1`, [row.id]);
      continue;
    }
    const fresh = await queryOne<ResponseRow>('SELECT * FROM responses WHERE id = $1', [row.id]);
    if (!fresh || fresh.status === 'done') continue;
    try {
      await importResponse(fresh);
    } catch (e) {
      const attempts = fresh.attempts + 1;
      const delayMin = Math.min(2 ** attempts, 30);
      if (e instanceof B24Error || /настроен|выключена|отключён/.test(errText(e))) brokenPortals.add(fresh.portal_id);
      await query(
        `UPDATE responses SET status = 'error', attempts = $2, last_error = $3,
           next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [fresh.id, attempts, errText(e).slice(0, 1000), delayMin],
      );
      // чтобы не засорять журнал при долгом сбое — пишем 1-ю, 3-ю и каждую 10-ю попытку
      if (attempts === 1 || attempts === 3 || attempts % 10 === 0) {
        await plog(
          fresh.portal_id,
          attempts >= 3 ? 'error' : 'warn',
          `Ошибка загрузки отклика ${fresh.negotiation_id}${fresh.candidate_name ? ` (${fresh.candidate_name})` : ''}, попытка ${attempts}, повтор через ${delayMin} мин: ${errText(e)}`,
        );
      }
    }
  }
  return rows.length;
}
