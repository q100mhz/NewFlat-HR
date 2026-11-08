import { config } from '../config.js';
import { HhClient, HhError } from './client.js';

export interface HhVacancy {
  id: string;
  name: string;
  area?: string;
  url?: string;
}

/** Активные вакансии работодателя (по менеджеру подключённого аккаунта) */
export async function listActiveVacancies(hh: HhClient, employerId: string, managerId: string | null): Promise<HhVacancy[]> {
  const out: HhVacancy[] = [];
  for (let page = 0; page < 20; page++) {
    const data = await hh.get(`/employers/${employerId}/vacancies/active`, {
      manager_id: managerId ?? undefined,
      per_page: 100,
      page,
    });
    for (const v of data?.items ?? []) out.push({ id: String(v.id), name: v.name, area: v.area?.name, url: v.alternate_url });
    if (!data || page >= (data.pages ?? 1) - 1) break;
  }
  return out;
}

/** Страница неразобранных откликов по вакансии (новые сверху) */
export async function listResponsesPage(hh: HhClient, vacancyId: string, page: number) {
  return hh.get('/negotiations/response', {
    vacancy_id: vacancyId,
    order_by: 'created_at',
    order: 'desc',
    per_page: 50,
    page,
  });
}

/** Полное резюме. URL из отклика содержит topic_id, с ним контакты открыты без расхода просмотров */
export async function getResume(hh: HhClient, negotiation: any) {
  const url: string | undefined = negotiation?.resume?.url;
  if (!url) throw new Error('В отклике нет ссылки на резюме (резюме скрыто или удалено)');
  return hh.get(url);
}

export async function getCoverLetter(hh: HhClient, negotiationId: string): Promise<string> {
  try {
    const data = await hh.get(`/negotiations/${negotiationId}/messages`, { per_page: 20 });
    const msgs: any[] = data?.items ?? [];
    const first = msgs.find((m) => m?.author?.participant_type === 'applicant' && m?.text);
    return first?.text ?? '';
  } catch {
    return '';
  }
}

export async function downloadResumePdf(hh: HhClient, resume: any): Promise<{ name: string; data: Buffer } | null> {
  const url: string | undefined = resume?.actions?.download?.pdf?.url;
  if (!url) return null;
  const data: Buffer = await hh.request('GET', url, { raw: true });
  const fio = [resume.last_name, resume.first_name].filter(Boolean).join('_') || 'resume';
  return { name: `Резюме_${fio}.pdf`.replace(/[\\/:*?"<>|\s]+/g, '_'), data };
}

/** Применяет действие к отклику (пригласить, отказать...). Берёт URL действия из самого отклика. */
export async function applyNegotiationAction(hh: HhClient, negotiationId: string, actionId: string, message: string) {
  const neg = await hh.get(`/negotiations/${negotiationId}`);
  const actions: any[] = neg?.actions ?? [];
  const action = actions.find((a) => a.id === actionId);
  const form: Record<string, string> = {};
  if (message.trim()) form.message = message.trim();
  if (action?.url) {
    return hh.request((action.method || 'PUT').toUpperCase(), action.url, { form });
  }
  const available = actions.map((a) => a.id).join(', ') || 'нет';
  throw new Error(`Действие «${actionId}» сейчас недоступно для отклика (доступны: ${available})`);
}

/** Подписка на вебхук hh.ru о новых откликах. Ошибки не критичны — работает опрос. */
export async function subscribeWebhook(hh: HhClient): Promise<string | null> {
  if (!config.hh.webhookEvent) return null;
  const url = `${config.publicUrl}/hh/webhook`;
  try {
    const existing = await hh.get('/webhook/subscriptions');
    const found = (existing?.items ?? []).find((s: any) => s.url === url);
    if (found) return String(found.id);
  } catch {
    /* список может быть недоступен */
  }
  const res = await hh.request('POST', '/webhook/subscriptions', {
    json: { url, actions: [{ type: config.hh.webhookEvent }] },
  });
  return res?.id ? String(res.id) : 'ok';
}

// ---------------- Разбор данных кандидата ----------------

export interface Candidate {
  firstName: string;
  lastName: string;
  middleName: string;
  fullName: string;
  phones: string[];
  emails: string[];
  birthDate: string | null;
  age: number | null;
  gender: string;
  city: string;
  position: string;
  salary: number | null;
  salaryCurrency: string;
  salaryText: string;
  experienceMonths: number | null;
  experienceText: string;
  resumeUrl: string;
}

function formatPhone(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.formatted) return String(v.formatted);
  const digits = [v.country, v.city, v.number].filter(Boolean).join('');
  return digits ? `+${digits.replace(/^\+/, '')}` : '';
}

export function plural(n: number, forms: [string, string, string]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

export function experienceToText(months: number | null): string {
  if (months == null) return '';
  const y = Math.floor(months / 12), m = months % 12;
  const parts: string[] = [];
  if (y) parts.push(`${y} ${plural(y, ['год', 'года', 'лет'])}`);
  if (m) parts.push(`${m} ${plural(m, ['месяц', 'месяца', 'месяцев'])}`);
  return parts.join(' ') || 'без опыта';
}

export function extractCandidate(resume: any, negotiation?: any): Candidate {
  const r = resume ?? {};
  const contacts: any[] = Array.isArray(r.contact) ? r.contact : [];
  const phones = contacts
    .filter((c) => ['cell', 'home', 'work'].includes(c?.type?.id))
    .map((c) => formatPhone(c.value))
    .filter(Boolean);
  const emails = contacts
    .filter((c) => c?.type?.id === 'email')
    .map((c) => (typeof c.value === 'string' ? c.value : c.value?.email ?? ''))
    .filter(Boolean);
  const firstName = r.first_name ?? negotiation?.resume?.first_name ?? '';
  const lastName = r.last_name ?? negotiation?.resume?.last_name ?? '';
  const middleName = r.middle_name ?? negotiation?.resume?.middle_name ?? '';
  const salary = r.salary?.amount ?? null;
  const currency = r.salary?.currency ?? '';
  const months = r.total_experience?.months ?? null;
  return {
    firstName,
    lastName,
    middleName,
    fullName: [lastName, firstName, middleName].filter(Boolean).join(' ') || 'Кандидат без имени',
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    birthDate: r.birth_date ?? null,
    age: r.age ?? null,
    gender: r.gender?.name ?? '',
    city: r.area?.name ?? '',
    position: r.title ?? negotiation?.resume?.title ?? '',
    salary,
    salaryCurrency: currency,
    salaryText: salary ? `${Number(salary).toLocaleString('ru-RU')} ${currency === 'RUR' ? '₽' : currency}` : '',
    experienceMonths: months,
    experienceText: experienceToText(months),
    resumeUrl: r.alternate_url ?? negotiation?.resume?.alternate_url ?? '',
  };
}

export { HhError };
