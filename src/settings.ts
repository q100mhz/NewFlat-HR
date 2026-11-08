import { z } from 'zod';

/** Данные кандидата из hh.ru, которые можно разложить по полям карточки Битрикс24 */
export const HH_FIELDS = {
  vacancyName: 'Название вакансии',
  vacancyId: 'ID вакансии hh.ru',
  vacancyUrl: 'Ссылка на вакансию',
  resumeUrl: 'Ссылка на резюме',
  position: 'Желаемая должность (из резюме)',
  city: 'Город',
  age: 'Возраст',
  birthDate: 'Дата рождения',
  gender: 'Пол',
  salary: 'Желаемая зарплата (число)',
  salaryText: 'Желаемая зарплата (текст с валютой)',
  experienceText: 'Опыт работы (текст)',
  experienceMonths: 'Опыт работы (месяцев)',
  phone: 'Телефон',
  email: 'Email',
  coverLetter: 'Сопроводительное письмо',
  negotiationId: 'ID отклика hh.ru',
  respondedAt: 'Дата отклика',
} as const;
export type HhFieldKey = keyof typeof HH_FIELDS;

/** Действия над откликом в hh.ru, которые можно привязать к стадии Битрикс24 */
export const HH_ACTIONS = {
  consider: 'Подумать',
  phone_interview: 'Телефонное интервью',
  interview: 'Приглашение на собеседование',
  assessment: 'Оценка / тестовое задание',
  offer: 'Предложение о работе',
  hired: 'Выход на работу',
  discard_by_employer: 'Отказ',
} as const;

const vacancyRule = z.object({
  enabled: z.boolean().default(true),
  assignedById: z.number().int().positive().nullable().default(null),
});

const stageAction = z.object({
  action: z.string().min(1),
  message: z.string().max(2000).default(''),
});

export const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** 2 — сделки, иначе entityTypeId смарт-процесса */
  entityTypeId: z.number().int().positive().default(2),
  categoryId: z.number().int().min(0).nullable().default(null),
  stageId: z.string().nullable().default(null),
  defaultAssignedById: z.number().int().positive().nullable().default(null),
  /** all — все активные вакансии; selected — только отмеченные */
  vacancyMode: z.enum(['all', 'selected']).default('all'),
  vacancies: z.record(z.string(), vacancyRule).default({}),
  titleTemplate: z.string().max(255).default('{vacancy} — {name}'),
  repeatPrefix: z.string().max(100).default('Повторный отклик'),
  sourceId: z.string().max(50).default(''),
  fieldMapping: z.record(z.string(), z.string()).default({}),
  attachPdf: z.boolean().default(true),
  timelineComment: z.boolean().default(true),
  pollIntervalMinutes: z.number().int().min(1).max(60).default(3),
  hhSync: z
    .object({
      enabled: z.boolean().default(false),
      stageActions: z.record(z.string(), stageAction).default({}),
    })
    .default({ enabled: false, stageActions: {} }),
});

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): Settings {
  const r = settingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

/** Готовы ли настройки к импорту */
export function isConfigured(s: Settings): boolean {
  return s.enabled && s.categoryId !== null && !!s.stageId;
}
