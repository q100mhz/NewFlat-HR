import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cache = new Map<string, string>();

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** JSON для вставки внутрь <script> */
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Простейший шаблонизатор: {{key}} — экранированная подстановка, {{{key}}} — без экранирования */
export function render(name: string, vars: Record<string, string>): string {
  let tpl = cache.get(name);
  if (!tpl || process.env.NODE_ENV !== 'production') {
    tpl = readFileSync(join(root, 'views', name), 'utf8');
    cache.set(name, tpl);
  }
  return tpl
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => vars[k] ?? '')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => escapeHtml(vars[k] ?? ''));
}

export function messagePage(title: string, text: string, opts: { ok?: boolean; script?: string } = {}): string {
  return render('message.html', {
    title,
    text,
    icon: opts.ok === false ? '⚠️' : '✅',
    script: opts.script ?? '',
  });
}
