/* Экран настроек коннектора HH → Битрикс24 (без сборки, чистый JS) */
(function () {
  'use strict';
  var BOOT = window.BOOT || {};
  var state = null; // ответ /api/state
  var S = null; // редактируемые настройки
  var meta = null; // справочники Битрикс24
  var stages = [];
  var vacancies = [];
  var dirty = false;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return '—';
    var x = new Date(d);
    return x.toLocaleDateString('ru-RU') + ' ' + x.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast hidden'; }, isErr ? 7000 : 3000);
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + BOOT.token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
        return data;
      });
    });
  }

  function markDirty() {
    if (!BOOT.isAdmin) return;
    dirty = true;
    $('savebar').classList.remove('hidden');
  }

  function options(list, selected, emptyLabel) {
    var html = emptyLabel !== undefined ? '<option value="">' + esc(emptyLabel) + '</option>' : '';
    return html + list.map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (String(o.id) === String(selected) ? ' selected' : '') + '>' + esc(o.name || o.title) + '</option>';
    }).join('');
  }

  // ---------------- вкладки ----------------
  $('tabs').addEventListener('click', function (e) {
    var tab = e.target.getAttribute('data-tab');
    if (!tab) return;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b === e.target); });
    document.querySelectorAll('[data-pane]').forEach(function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== tab); });
    if (tab === 'journal') loadJournal();
    if (tab === 'vacancies' && !vacancies.length) loadVacancies(false);
  });

  // ---------------- загрузка состояния ----------------
  function loadState() {
    return api('GET', '/api/state').then(function (st) {
      state = st;
      S = JSON.parse(JSON.stringify(st.settings));
      renderConnect();
      renderPipelineStatic();
      renderBadge();
      return loadMeta(S.entityTypeId);
    });
  }

  function renderBadge() {
    var b = $('status-badge');
    var ready = S.enabled && S.categoryId !== null && S.stageId && state.hasB24Credentials && state.accounts.length;
    b.textContent = ready ? 'Синхронизация включена' : 'Не настроено / выключено';
    b.className = 'badge ' + (ready ? 'on' : 'off');
  }

  function renderConnect() {
    $('portal-line').textContent = state.domain + (BOOT.userName ? ' · ' + BOOT.userName : '');
    $('readonly-note').classList.toggle('hidden', !!BOOT.isAdmin);
    $('b24-creds-ok').classList.toggle('hidden', !state.hasB24Credentials);
    $('b24-creds-form').classList.toggle('hidden', state.hasB24Credentials);
    $('b24-client-id').textContent = state.b24ClientId || '';
    $('hh-unavailable').classList.toggle('hidden', state.hh.available);
    $('hh-redirect').textContent = state.hh.redirectUri;
    $('hh-own-id').value = state.hh.ownClientId || '';

    var tbody = document.querySelector('#hh-accounts tbody');
    if (!state.accounts.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">Аккаунты не подключены</td></tr>';
    } else {
      tbody.innerHTML = state.accounts.map(function (a) {
        var since = a.importSince ? new Date(a.importSince).toISOString().slice(0, 10) : '';
        return '<tr' + (a.active ? '' : ' class="dim"') + '>' +
          '<td>' + esc(a.managerName) + (a.lastError ? '<div class="err-text">' + esc(a.lastError) + '</div>' : '') + '</td>' +
          '<td>' + esc(a.employerName) + '</td>' +
          '<td><input type="date" data-since="' + a.id + '" value="' + since + '"></td>' +
          '<td>' + fmtDate(a.lastPollAt) + '</td>' +
          '<td><button class="btn danger" data-disconnect="' + a.id + '">Отключить</button></td></tr>';
      }).join('');
    }
  }

  function renderPipelineStatic() {
    $('s-enabled').checked = !!S.enabled;
    $('s-title').value = S.titleTemplate;
    $('s-repeat').value = S.repeatPrefix;
    $('s-pdf').checked = !!S.attachPdf;
    $('s-comment').checked = !!S.timelineComment;
    $('s-interval').value = S.pollIntervalMinutes;
    $('s-sync').checked = !!S.hhSync.enabled;
    document.querySelectorAll('input[name=vmode]').forEach(function (r) { r.checked = r.value === S.vacancyMode; });
  }

  function loadMeta(entityTypeId) {
    return api('GET', '/api/b24/meta?entityTypeId=' + entityTypeId).then(function (m) {
      meta = m;
      $('s-entity').innerHTML = options(m.entityTypes, S.entityTypeId);
      $('s-category').innerHTML = options(m.categories, S.categoryId, '— выберите воронку —');
      $('s-assigned').innerHTML = options(m.users, S.defaultAssignedById, '— пользователь приложения —');
      $('s-source').innerHTML = options(m.sources, S.sourceId, '— не указывать —');
      renderFields();
      renderVacancies();
      return loadStages();
    }).catch(function (e) { toast('Не удалось загрузить данные Битрикс24: ' + e.message, true); });
  }

  function loadStages() {
    if (S.categoryId === null || S.categoryId === undefined) {
      stages = [];
      $('s-stage').innerHTML = '<option value="">— сначала выберите воронку —</option>';
      renderStageTable();
      return Promise.resolve();
    }
    return api('GET', '/api/b24/stages?entityTypeId=' + S.entityTypeId + '&categoryId=' + S.categoryId).then(function (list) {
      stages = list;
      $('s-stage').innerHTML = options(list, S.stageId, '— выберите стадию —');
      renderStageTable();
    });
  }

  function renderFields() {
    var fields = meta.fields.slice().sort(function (a, b) { return (b.custom - a.custom) || a.title.localeCompare(b.title); });
    var hhFields = state.dictionaries.hhFields;
    document.querySelector('#fields-table tbody').innerHTML = Object.keys(hhFields).map(function (k) {
      var list = fields.map(function (f) { return { id: f.id, name: f.title + ' (' + f.type + ')' }; });
      return '<tr><td>' + esc(hhFields[k]) + '</td><td><select data-map="' + k + '">' + options(list, S.fieldMapping[k] || '', '— не заполнять —') + '</select></td></tr>';
    }).join('');
  }

  function renderStageTable() {
    var actions = state.dictionaries.hhActions;
    var actList = Object.keys(actions).map(function (k) { return { id: k, name: actions[k] }; });
    var tbody = document.querySelector('#stage-table tbody');
    if (!stages.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">Выберите воронку на вкладке «Воронка»</td></tr>';
      return;
    }
    tbody.innerHTML = stages.map(function (st) {
      var rule = S.hhSync.stageActions[st.id] || {};
      return '<tr><td>' + esc(st.name) + '</td>' +
        '<td><select data-stage-action="' + esc(st.id) + '">' + options(actList, rule.action || '', '— ничего не делать —') + '</select></td>' +
        '<td><input type="text" data-stage-msg="' + esc(st.id) + '" value="' + esc(rule.message || '') + '" placeholder="Необязательно"></td></tr>';
    }).join('');
  }

  // ---------------- вакансии ----------------
  function loadVacancies(force) {
    var tbody = document.querySelector('#vac-table tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Загрузка…</td></tr>';
    return api('GET', '/api/hh/vacancies' + (force ? '?force=1' : '')).then(function (list) {
      vacancies = list;
      renderVacancies();
    }).catch(function (e) { tbody.innerHTML = '<tr><td colspan="5" class="err-text">' + esc(e.message) + '</td></tr>'; });
  }

  function renderVacancies() {
    if (!meta) return;
    var tbody = document.querySelector('#vac-table tbody');
    if (!vacancies.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">' + (state.accounts.length ? 'Нет активных вакансий' : 'Подключите аккаунт hh.ru') + '</td></tr>';
      return;
    }
    tbody.innerHTML = vacancies.map(function (v) {
      if (v.error) return '<tr><td colspan="5" class="err-text">' + esc(v.error) + '</td></tr>';
      var rule = S.vacancies[v.id] || {};
      var on = S.vacancyMode === 'all' ? rule.enabled !== false : rule.enabled === true;
      return '<tr' + (on ? '' : ' class="dim"') + '>' +
        '<td><input type="checkbox" data-vac="' + esc(v.id) + '"' + (on ? ' checked' : '') + '></td>' +
        '<td>' + (v.url ? '<a href="' + esc(v.url) + '" target="_blank">' + esc(v.name) + '</a>' : esc(v.name)) + '</td>' +
        '<td>' + esc(v.area) + '</td><td>' + esc(v.account) + '</td>' +
        '<td><select data-vac-user="' + esc(v.id) + '">' + options(meta.users, rule.assignedById || '', '— по умолчанию —') + '</select></td></tr>';
    }).join('');
  }

  function vacRule(id) {
    if (!S.vacancies[id]) S.vacancies[id] = { enabled: S.vacancyMode === 'all', assignedById: null };
    return S.vacancies[id];
  }

  // ---------------- журнал ----------------
  var STATUS = { done: 'Загружен', pending: 'В очереди', error: 'Ошибка', skipped: 'Пропущен' };
  function itemLink(r) {
    if (!r.b24_item_id) return '';
    var path = r.b24_entity_type_id === 2 ? '/crm/deal/details/' + r.b24_item_id + '/' : '/crm/type/' + r.b24_entity_type_id + '/details/' + r.b24_item_id + '/';
    return 'https://' + state.domain + path;
  }
  function loadJournal() {
    api('GET', '/api/state').then(function (st) {
      var s = st.stats;
      $('stats').innerHTML =
        '<div class="stat"><b>' + s.today + '</b>за сутки</div>' +
        '<div class="stat"><b>' + s.done + '</b>загружено всего</div>' +
        '<div class="stat"><b>' + s.pending + '</b>в очереди</div>' +
        '<div class="stat"><b>' + s.errors + '</b>с ошибкой</div>';
    });
    api('GET', '/api/responses').then(function (rows) {
      var tbody = document.querySelector('#resp-table tbody');
      tbody.innerHTML = rows.length ? rows.map(function (r) {
        var link = itemLink(r);
        var name = esc(r.candidate_name || '—') + (r.is_repeat ? ' <span class="muted">(повторный)</span>' : '');
        var hh = r.hh_action ? 'ожидает: ' + esc(state.dictionaries.hhActions[r.hh_action] || r.hh_action) : (r.hh_last_action ? esc(state.dictionaries.hhActions[r.hh_last_action] || r.hh_last_action) : '');
        if (r.hh_action_error) hh += '<div class="err-text">' + esc(r.hh_action_error) + '</div>';
        return '<tr><td>' + fmtDate(r.hh_created_at) + '</td>' +
          '<td>' + (link ? '<a href="' + link + '" target="_blank">' + name + '</a>' : name) + '</td>' +
          '<td>' + esc(r.vacancy_name) + '</td>' +
          '<td><span class="st ' + r.status + '">' + (STATUS[r.status] || r.status) + '</span>' +
          (r.last_error && r.status !== 'done' ? '<div class="err-text">' + esc(r.last_error) + '</div>' : '') + '</td>' +
          '<td>' + hh + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">Откликов пока нет</td></tr>';
    });
    api('GET', '/api/logs').then(function (rows) {
      $('logs').innerHTML = rows.length ? rows.map(function (l) {
        return '<div class="' + l.level + '"><time>' + fmtDate(l.created_at) + '</time>' + esc(l.message) + '</div>';
      }).join('') : '<div class="muted">Событий нет</div>';
    });
  }

  // ---------------- обработчики ----------------
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 's-enabled') S.enabled = t.checked;
    else if (t.id === 's-entity') {
      S.entityTypeId = Number(t.value); S.categoryId = null; S.stageId = null; S.fieldMapping = {}; S.hhSync.stageActions = {};
      loadMeta(S.entityTypeId);
    } else if (t.id === 's-category') {
      S.categoryId = t.value === '' ? null : Number(t.value); S.stageId = null; S.hhSync.stageActions = {};
      loadStages();
    } else if (t.id === 's-stage') S.stageId = t.value || null;
    else if (t.id === 's-assigned') S.defaultAssignedById = t.value ? Number(t.value) : null;
    else if (t.id === 's-source') S.sourceId = t.value;
    else if (t.id === 's-interval') S.pollIntervalMinutes = Math.max(1, Math.min(60, Number(t.value) || 3));
    else if (t.id === 's-pdf') S.attachPdf = t.checked;
    else if (t.id === 's-comment') S.timelineComment = t.checked;
    else if (t.id === 's-sync') S.hhSync.enabled = t.checked;
    else if (t.name === 'vmode') { S.vacancyMode = t.value; renderVacancies(); }
    else if (t.hasAttribute('data-vac')) { vacRule(t.getAttribute('data-vac')).enabled = t.checked; t.closest('tr').classList.toggle('dim', !t.checked); }
    else if (t.hasAttribute('data-vac-user')) vacRule(t.getAttribute('data-vac-user')).assignedById = t.value ? Number(t.value) : null;
    else if (t.hasAttribute('data-map')) {
      if (t.value) S.fieldMapping[t.getAttribute('data-map')] = t.value; else delete S.fieldMapping[t.getAttribute('data-map')];
    } else if (t.hasAttribute('data-stage-action')) {
      var id = t.getAttribute('data-stage-action');
      if (t.value) S.hhSync.stageActions[id] = { action: t.value, message: (S.hhSync.stageActions[id] || {}).message || '' };
      else delete S.hhSync.stageActions[id];
    } else if (t.hasAttribute('data-since')) {
      api('POST', '/api/hh/accounts/' + t.getAttribute('data-since'), { importSince: t.value })
        .then(function () { toast('Дата сохранена'); }).catch(function (err) { toast(err.message, true); });
      return;
    } else return;
    markDirty();
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 's-title') S.titleTemplate = t.value;
    else if (t.id === 's-repeat') S.repeatPrefix = t.value;
    else if (t.hasAttribute('data-stage-msg')) {
      var id = t.getAttribute('data-stage-msg');
      if (!S.hhSync.stageActions[id]) return;
      S.hhSync.stageActions[id].message = t.value;
    } else return;
    markDirty();
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-disconnect')) {
      if (!confirm('Отключить этот аккаунт hh.ru? Новые отклики по нему перестанут загружаться.')) return;
      api('DELETE', '/api/hh/accounts/' + t.getAttribute('data-disconnect')).then(loadState).catch(function (err) { toast(err.message, true); });
    }
  });

  $('save').addEventListener('click', function () {
    var btn = $('save');
    btn.disabled = true;
    api('POST', '/api/settings', S).then(function () {
      dirty = false;
      $('savebar').classList.add('hidden');
      state.settings = JSON.parse(JSON.stringify(S));
      renderBadge();
      toast('Настройки сохранены');
    }).catch(function (e) { toast(e.message, true); }).then(function () { btn.disabled = false; });
  });

  $('b24-creds-save').addEventListener('click', function () {
    api('POST', '/api/b24-credentials', { clientId: $('b24-client-id-input').value, clientSecret: $('b24-client-secret-input').value })
      .then(function () { toast('Ключи проверены и сохранены'); return loadState(); })
      .catch(function (e) { toast(e.message, true); });
  });
  $('b24-creds-change').addEventListener('click', function () {
    $('b24-creds-form').classList.remove('hidden');
    $('b24-creds-ok').classList.add('hidden');
  });

  $('hh-connect').addEventListener('click', function () {
    if (!BOOT.isAdmin) return toast('Подключать аккаунты может только администратор', true);
    window.open('/hh/connect?s=' + encodeURIComponent(BOOT.token), 'hh_oauth', 'width=720,height=760');
  });
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'hh-connected') {
      loadState().then(function () { loadVacancies(true); });
      if (e.data.ok) toast('Аккаунт hh.ru подключён');
    }
  });

  $('hh-own-save').addEventListener('click', function () {
    api('POST', '/api/hh/credentials', { clientId: $('hh-own-id').value, clientSecret: $('hh-own-secret').value })
      .then(function () { toast('Ключи hh.ru сохранены'); return loadState(); })
      .catch(function (e) { toast(e.message, true); });
  });
  $('hh-own-reset').addEventListener('click', function () {
    api('POST', '/api/hh/credentials', {}).then(function () { toast('Используется общее приложение'); return loadState(); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('vac-reload').addEventListener('click', function () { loadVacancies(true); });
  $('journal-reload').addEventListener('click', loadJournal);
  $('sync-now').addEventListener('click', function () {
    api('POST', '/api/sync-now').then(function () {
      toast('Проверка запущена, обновите журнал через минуту');
      setTimeout(loadJournal, 15000);
    }).catch(function (e) { toast(e.message, true); });
  });
  $('retry').addEventListener('click', function () {
    api('POST', '/api/retry-errors').then(function (r) { toast('Повторно в очереди: ' + r.count); loadJournal(); })
      .catch(function (e) { toast(e.message, true); });
  });

  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  if (window.BX24) BX24.init(function () {});
  if (!BOOT.isAdmin) document.querySelectorAll('main input, main select, main button').forEach(function (el) {
    if (!['journal-reload'].includes(el.id)) el.disabled = true;
  });
  loadState().catch(function (e) { toast(e.message, true); });
})();
