import { Tasks, Events, PushSubscriptions, TaskOccurrences } from './supabase-client.js';
import { chooseVaultFolder, getSavedVaultFolder, scanVaultTasks, writeTaskDoneBackToFile } from './fs-obsidian.js';

const VAPID_PUBLIC_KEY = 'BAPUfQl6z7y6oxsKp8QdaiiurMvqhBlA549o6T3M2gN0k1zzODZfa1FY2T2I6sBdAc3rkFkbIZXv7VPMWPgLbY8';
const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

let vaultHandle = null;
let cachedTasks = [];
let cachedEvents = [];
let cachedOccurrences = {}; // task_id -> done (para a data de hoje)
let activeType = 'tarefa'; // 'tarefa' | 'compromisso'
let selectedRepeatDays = [];

const el = (sel) => document.querySelector(sel);
const CHECK_SVG = '<svg width="11" height="9" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="#0d1117" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tarefas visíveis hoje: avulsas (sem recorrência) + recorrentes cujo dia da semana bate com hoje. */
function tasksForToday() {
  const todayWeekday = new Date().getDay();
  return cachedTasks.filter((t) => {
    if (!t.recurrence_days || t.recurrence_days.length === 0) return true;
    return t.recurrence_days.includes(todayWeekday);
  });
}

function isTaskDoneToday(task) {
  if (task.recurrence_days && task.recurrence_days.length > 0) {
    return !!cachedOccurrences[task.id];
  }
  return task.done;
}

// ---------- Abas Tarefa / Compromisso (filtro) ----------
function initTypeTabs() {
  document.querySelectorAll('#type-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeType = btn.dataset.type;
      document.querySelectorAll('#type-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const form = el('#form-item');
      form.dataset.type = activeType;
      el('#btn-add-item').textContent = activeType === 'tarefa' ? 'Adicionar tarefa' : 'Adicionar compromisso';

      renderList();
    });
  });
}

// ---------- Progresso do dia (tarefas visíveis hoje) ----------
function renderProgress() {
  const todayTasks = tasksForToday();
  const total = todayTasks.length;
  const done = todayTasks.filter((t) => isTaskDoneToday(t)).length;
  const allDone = total > 0 && done === total;

  el('#progress-reading').textContent = `${done}/${total} concluídas`;
  el('#progress-reading').style.color = allDone ? 'var(--success)' : 'var(--text-secondary)';

  const chain = el('#progress-chain');
  chain.innerHTML = '';
  const dotsCount = Math.max(total, 1);
  for (let i = 0; i < dotsCount; i++) {
    const dot = document.createElement('div');
    dot.className = 'progress-dot';
    if (i < done) dot.style.background = allDone ? 'var(--success)' : 'var(--accent)';
    chain.appendChild(dot);
  }
}

// ---------- Lista filtrada por tipo ----------
function renderList() {
  const container = el('#items-list');
  container.innerHTML = '';

  if (activeType === 'tarefa') {
    const sorted = tasksForToday().sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    sorted.forEach((t) => container.appendChild(renderTaskItem(t)));
    if (sorted.length === 0) {
      container.innerHTML = '<p class="empty">Nenhuma tarefa por aqui ainda.</p>';
    }
  } else {
    const sorted = [...cachedEvents].sort((a, b) => a.start_at.localeCompare(b.start_at));
    sorted.forEach((e) => container.appendChild(renderEventItem(e)));
    if (sorted.length === 0) {
      container.innerHTML = '<p class="empty">Nenhum compromisso por aqui ainda.</p>';
    }
  }

  renderProgress();
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function renderEventItem(event) {
  const li = document.createElement('div');
  li.className = 'item item-event';
  const date = new Date(event.start_at);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const isoDate = event.start_at.slice(0, 10);
  const isoTime = event.start_at.slice(11, 16);

  li.innerHTML = `
    <div class="item-body">
      <div class="item-view">
        <span class="item-title">${event.title}</span>
        <div class="item-meta"><span class="item-time">${day} · ${time}</span></div>
      </div>
      <div class="item-edit" hidden>
        <input type="date" class="edit-date" value="${isoDate}" />
        <input type="time" class="edit-time" value="${isoTime}" />
      </div>
    </div>
    <button class="btn-icon btn-edit" title="Reagendar">✎</button>
    <button class="btn-icon btn-delete" title="Excluir">✕</button>
  `;

  li.querySelector('.btn-edit').addEventListener('click', () => li.classList.toggle('editing'));

  const saveReschedule = async () => {
    const newDate = li.querySelector('.edit-date').value;
    const newTime = li.querySelector('.edit-time').value || '00:00';
    if (!newDate) return;
    await Events.setStartAt(event.id, new Date(`${newDate}T${newTime}`).toISOString());
    await loadAll();
  };

  li.querySelector('.edit-date').addEventListener('change', saveReschedule);
  li.querySelector('.edit-time').addEventListener('change', saveReschedule);

  li.querySelector('.btn-delete').addEventListener('click', async () => {
    await Events.delete(event.id);
    await loadAll();
  });
  return li;
}

function renderTaskItem(task) {
  const done = isTaskDoneToday(task);
  const isRecurring = task.recurrence_days && task.recurrence_days.length > 0;

  const li = document.createElement('div');
  li.className = 'item item-task' + (done ? ' done' : '');
  const tagsHtml = (task.tags || []).map((t) => `<span class="tag">#${t}</span>`).join(' ');
  const sourceHtml = task.source === 'obsidian'
    ? `<span class="badge badge-obsidian" title="${task.source_file}">Obsidian</span>`
    : `<span class="badge badge-manual">Manual</span>`;
  const dateHtml = task.due_date ? `<span class="item-time">${formatDate(task.due_date)}</span>` : '';
  const repeatHtml = isRecurring
    ? `<span class="badge badge-repeat" title="Repete">↻ ${task.recurrence_days.map((d) => WEEKDAY_LABELS[d]).join(', ')}</span>`
    : '';

  const editBtnHtml = isRecurring
    ? ''
    : '<button class="btn-icon btn-edit" title="Reagendar">✎</button>';

  li.innerHTML = `
    <div class="item-check" role="checkbox" aria-checked="${done}" tabindex="0">${CHECK_SVG}</div>
    <div class="item-body">
      <div class="item-view">
        <span class="item-title">${task.title}</span>
        <div class="item-meta">${dateHtml}${repeatHtml}${tagsHtml}${sourceHtml}</div>
      </div>
      ${isRecurring ? '' : `<div class="item-edit" hidden><input type="date" class="edit-date" value="${task.due_date || ''}" /></div>`}
    </div>
    ${editBtnHtml}
    <button class="btn-icon btn-delete" title="Excluir">✕</button>
  `;

  if (!isRecurring) {
    li.querySelector('.btn-edit').addEventListener('click', () => li.classList.toggle('editing'));
    li.querySelector('.edit-date').addEventListener('change', async (ev) => {
      await Tasks.setDueDate(task.id, ev.target.value || null);
      await loadAll();
    });
  }

  const toggle = async () => {
    const newDone = !done;
    if (isRecurring) {
      await TaskOccurrences.setDone(task.id, todayDateStr(), newDone);
    } else {
      await Tasks.setDone(task.id, newDone);
      if (task.source === 'obsidian' && vaultHandle) {
        try {
          await writeTaskDoneBackToFile(vaultHandle, task.source_file, task.line_number, newDone);
        } catch (err) {
          console.warn('Não consegui atualizar o arquivo original:', err);
        }
      }
    }
    await loadAll();
  };

  const checkEl = li.querySelector('.item-check');
  checkEl.addEventListener('click', toggle);
  checkEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggle();
    }
  });

  li.querySelector('.btn-delete').addEventListener('click', async () => {
    await Tasks.delete(task.id);
    await loadAll();
  });

  return li;
}

// ---------- Seletor de dias da semana (repetição) ----------
function initWeekdayPicker() {
  document.querySelectorAll('#weekday-picker .weekday-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.day);
      btn.classList.toggle('selected');
      selectedRepeatDays = selectedRepeatDays.includes(day)
        ? selectedRepeatDays.filter((d) => d !== day)
        : [...selectedRepeatDays, day];

      el('#form-item').classList.toggle('has-repeat', selectedRepeatDays.length > 0);
    });
  });
}

function resetWeekdayPicker() {
  selectedRepeatDays = [];
  document.querySelectorAll('#weekday-picker .weekday-btn').forEach((btn) => btn.classList.remove('selected'));
  el('#form-item').classList.remove('has-repeat');
}

// ---------- Formulário único (adapta campos conforme a aba ativa) ----------
function initItemForm() {
  el('#form-item').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const title = form.title.value.trim();
    const errorEl = el('#title-error');

    if (!title) {
      errorEl.textContent = 'Título obrigatório';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    if (activeType === 'tarefa') {
      const tags = form.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
      const isRecurring = selectedRepeatDays.length > 0;
      await Tasks.createManual({
        title,
        due_date: isRecurring ? null : form.date.value || null,
        tags,
        done: false,
        recurrence_days: isRecurring ? [...selectedRepeatDays].sort() : null,
      });
    } else {
      const date = form.date_evento.value;
      if (!date) {
        errorEl.textContent = 'Data obrigatória';
        errorEl.hidden = false;
        return;
      }
      const time = form.time.value || '00:00';
      await Events.create({
        title,
        start_at: new Date(`${date}T${time}`).toISOString(),
        notes: form.notes.value.trim() || null,
      });
    }

    form.reset();
    form.dataset.type = activeType;
    resetWeekdayPicker();
    await loadAll();
  });
}

// ---------- Vault (conectar / sincronizar Obsidian) ----------
function setVaultConnected(name) {
  const valueEl = el('#vault-value');
  valueEl.textContent = 'Conectado';
  valueEl.style.color = 'var(--success)';
  el('#vault-desc').textContent = `Pasta: ${name}`;
  el('#btn-vault-action').textContent = 'Sincronizar';
}

function initVaultCard() {
  el('#btn-vault-action').addEventListener('click', async () => {
    const btn = el('#btn-vault-action');
    const statusEl = el('#vault-status');

    if (!vaultHandle) {
      try {
        vaultHandle = await chooseVaultFolder();
        setVaultConnected(vaultHandle.name);
      } catch (err) {
        if (err.name !== 'AbortError') console.error(err);
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sincronizando…';
    statusEl.textContent = 'Lendo arquivos .md...';

    try {
      const parsedTasks = await scanVaultTasks(vaultHandle);
      const payload = parsedTasks.map((t) => ({
        title: t.title,
        done: t.done,
        tags: t.tags,
        due_date: t.dueDate,
        source: 'obsidian',
        source_file: t.sourceFile,
        line_number: t.lineNumber,
      }));

      if (payload.length === 0) {
        statusEl.textContent = 'Nenhuma tarefa encontrada (procurando por "- [ ]" nos .md).';
      } else {
        await Tasks.upsertFromObsidian(payload);
        statusEl.textContent = `${payload.length} tarefa(s) importada(s)/atualizada(s).`;
        await loadAll();
      }
    } catch (err) {
      console.error('Falha ao sincronizar o vault:', err);
      statusEl.textContent = `Erro ao sincronizar: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sincronizar';
    }
  });
}

async function tryReconnectVault() {
  vaultHandle = await getSavedVaultFolder();
  if (vaultHandle) setVaultConnected(vaultHandle.name);
}

// ---------- Push notifications ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function refreshPushBadge() {
  const allowed = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const valueEl = el('#push-value');
  valueEl.textContent = allowed ? 'Permitido' : 'Negado';
  valueEl.style.color = allowed ? 'var(--success)' : 'var(--error-soft)';
  el('#btn-enable-push').textContent = allowed ? 'Revogar' : 'Permitir';
}

// Evita ficar preso numa versão antiga do app.js/style.css: quando um novo
// service worker assume o controle da página, recarrega automaticamente.
function initServiceWorkerAutoReload() {
  if (!('serviceWorker' in navigator)) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

async function initPush() {
  refreshPushBadge();

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el('#push-status').textContent = 'Este navegador não suporta push notifications.';
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');

  el('#btn-enable-push').addEventListener('click', async () => {
    const statusEl = el('#push-status');
    const perm = await Notification.requestPermission();
    refreshPushBadge();
    if (perm !== 'granted') {
      statusEl.textContent = 'Permissão de notificação negada pelo navegador.';
      return;
    }

    if (VAPID_PUBLIC_KEY.includes('SUA_CHAVE')) {
      statusEl.textContent = 'Permissão concedida — falta configurar a chave VAPID para ativar o push real.';
      return;
    }

    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await PushSubscriptions.save({ subscription: sub.toJSON() });
      statusEl.textContent = 'Notificações ativadas.';
    } catch (err) {
      console.error('Falha ao inscrever push:', err);
      statusEl.textContent = 'Permissão concedida, mas a inscrição push falhou (veja o console).';
    }
  });
}

function renderTodayLabel() {
  const label = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  el('#today-label').textContent = `Hoje, ${label}`;
}

// ---------- Carregamento geral ----------
async function loadAll() {
  const [tasks, events, occurrences] = await Promise.all([
    Tasks.listAll(),
    Events.listAll(),
    TaskOccurrences.listForDate(todayDateStr()),
  ]);
  cachedTasks = tasks;
  cachedEvents = events;
  cachedOccurrences = Object.fromEntries(occurrences.map((o) => [o.task_id, o.done]));
  renderList();
}

async function main() {
  renderTodayLabel();
  initServiceWorkerAutoReload();
  initTypeTabs();
  initWeekdayPicker();
  initItemForm();
  initVaultCard();
  await initPush();
  await tryReconnectVault();
  await loadAll();
}

main().catch(console.error);
