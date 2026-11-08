import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_URL = 'https://hr.test';
process.env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/none';
process.env.SECRET_KEY = 'x'.repeat(40);

const { extractCandidate, experienceToText } = await import('../src/hh/api.ts');
const { renderTitle, convertValue } = await import('../src/sync/importer.ts');
const { vacanciesToPoll } = await import('../src/sync/poller.ts');
const { parseSettings } = await import('../src/settings.ts');
const { encrypt, decrypt, sign, verify } = await import('../src/crypto.ts');
const { isValidPortalDomain } = await import('../src/b24/client.ts');

const resume = {
  id: 'r1', first_name: 'Иван', last_name: 'Петров', middle_name: 'Сергеевич', age: 31, title: 'Менеджер по продажам',
  area: { name: 'Москва' }, salary: { amount: 120000, currency: 'RUR' }, total_experience: { months: 62 },
  alternate_url: 'https://hh.ru/resume/r1',
  contact: [
    { type: { id: 'cell' }, value: { country: '7', city: '916', number: '1234567', formatted: '+7 (916) 123-45-67' } },
    { type: { id: 'email' }, value: 'ivan@example.ru' },
  ],
};

test('разбор резюме', () => {
  const c = extractCandidate(resume);
  assert.equal(c.fullName, 'Петров Иван Сергеевич');
  assert.deepEqual(c.phones, ['+7 (916) 123-45-67']);
  assert.deepEqual(c.emails, ['ivan@example.ru']);
  assert.equal(c.experienceText, '5 лет 2 месяца');
  assert.equal(experienceToText(0), 'без опыта');
  assert.match(c.salaryText, /120.000 ₽/);
});

test('название карточки и повторный отклик', () => {
  const s = parseSettings({});
  const c = extractCandidate(resume);
  assert.equal(renderTitle(s, c, 'Продавец', false), 'Продавец — Петров Иван Сергеевич');
  assert.equal(renderTitle(s, c, 'Продавец', true), 'Повторный отклик: Продавец — Петров Иван Сергеевич');
});

test('приведение типов полей', () => {
  assert.equal(convertValue(120000, { type: 'money' }, 'RUR'), '120000|RUB');
  assert.equal(convertValue('62', { type: 'integer' }), 62);
  assert.deepEqual(convertValue('x', { type: 'string', isMultiple: true }), ['x']);
  assert.equal(convertValue('', { type: 'string' }), undefined);
  assert.equal(convertValue('a', { type: 'enumeration' }), undefined);
});

test('выбор вакансий', () => {
  const active = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
  const all = parseSettings({ vacancyMode: 'all', vacancies: { '2': { enabled: false } } });
  assert.deepEqual(vacanciesToPoll(all, active).map((v) => v.id), ['1']);
  const sel = parseSettings({ vacancyMode: 'selected', vacancies: { '2': { enabled: true } } });
  assert.deepEqual(vacanciesToPoll(sel, active).map((v) => v.id), ['2']);
});

test('шифрование и подпись', () => {
  assert.equal(decrypt(encrypt('секрет')), 'секрет');
  const t = sign({ pid: 5 }, 60);
  assert.equal(verify<any>(t)?.pid, 5);
  assert.equal(verify(t.slice(0, -2) + 'xx'), null);
  assert.equal(verify(sign({ pid: 5 }, -1)), null);
});

test('проверка домена портала', () => {
  assert.ok(isValidPortalDomain('company.bitrix24.ru'));
  assert.ok(isValidPortalDomain('crm.company.ru'));
  assert.ok(!isValidPortalDomain('127.0.0.1'));
  assert.ok(!isValidPortalDomain('localhost'));
  assert.ok(!isValidPortalDomain('evil.com/x'));
});
