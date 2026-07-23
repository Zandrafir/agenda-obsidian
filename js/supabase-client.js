// Preencher após criar o projeto Supabase (Configurações > API).
const SUPABASE_URL = 'https://bgnitauztmzqpxywzcho.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnbml0YXV6dG16cXB4eXd6Y2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MzI2NDUsImV4cCI6MjEwMDQwODY0NX0.jLLzP6wr9QDKxB0JknptmvC-kZSRF_0knF6DWgn_WiU';
const IS_CONFIGURED = !SUPABASE_URL.includes('SEU-PROJETO');

const REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Wrapper simples para a REST API do Supabase (PostgREST). */
async function api(path, { method = 'GET', body, extraHeaders } = {}) {
  const res = await fetch(`${REST_URL}/${path}`, {
    method,
    headers: headers(extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} falhou: ${res.status} ${text}`);
  }
  const contentLength = res.headers.get('content-length');
  if (contentLength === '0') return null;
  return res.json().catch(() => null);
}

const Tasks = {
  listAll: () => api('tasks?select=*&order=due_date.asc.nullslast'),

  upsertFromObsidian: (tasks) =>
    api('tasks?on_conflict=source_file,line_number', {
      method: 'POST',
      body: tasks,
      extraHeaders: { Prefer: 'resolution=merge-duplicates,return=representation' },
    }),

  createManual: (task) =>
    api('tasks', {
      method: 'POST',
      body: { ...task, source: 'manual' },
      extraHeaders: { Prefer: 'return=representation' },
    }),

  setDone: (id, done) =>
    api(`tasks?id=eq.${id}`, {
      method: 'PATCH',
      body: { done, updated_at: new Date().toISOString() },
      extraHeaders: { Prefer: 'return=representation' },
    }),

  setDueDate: (id, dueDate) =>
    api(`tasks?id=eq.${id}`, {
      method: 'PATCH',
      body: { due_date: dueDate, updated_at: new Date().toISOString() },
      extraHeaders: { Prefer: 'return=representation' },
    }),

  delete: (id) => api(`tasks?id=eq.${id}`, { method: 'DELETE' }),
};

const Events = {
  listAll: () => api('events?select=*&order=start_at.asc'),

  create: (event) =>
    api('events', {
      method: 'POST',
      body: event,
      extraHeaders: { Prefer: 'return=representation' },
    }),

  setStartAt: (id, startAt) =>
    api(`events?id=eq.${id}`, {
      method: 'PATCH',
      body: { start_at: startAt, updated_at: new Date().toISOString() },
      extraHeaders: { Prefer: 'return=representation' },
    }),

  delete: (id) => api(`events?id=eq.${id}`, { method: 'DELETE' }),
};

const PushSubscriptions = {
  save: (subscription) =>
    api('push_subscriptions', {
      method: 'POST',
      body: subscription,
      extraHeaders: { Prefer: 'resolution=merge-duplicates' },
    }),
};

const TaskOccurrences = {
  listForDate: (date) => api(`task_occurrences?select=*&occurrence_date=eq.${date}`),

  setDone: (taskId, date, done) =>
    api('task_occurrences?on_conflict=task_id,occurrence_date', {
      method: 'POST',
      body: { task_id: taskId, occurrence_date: date, done, updated_at: new Date().toISOString() },
      extraHeaders: { Prefer: 'resolution=merge-duplicates,return=representation' },
    }),
};

// Enquanto SUPABASE_URL/KEY não forem preenchidas com valores reais, usa localStorage
// como fallback — permite testar parsing/importação/UI sem depender do backend.
let ExportedTasks = Tasks;
let ExportedEvents = Events;
let ExportedPushSubscriptions = PushSubscriptions;
let ExportedTaskOccurrences = TaskOccurrences;

if (!IS_CONFIGURED) {
  console.warn('[supabase-client] Credenciais não configuradas — usando fallback local (localStorage).');
  const local = await import('./local-store.js');
  ExportedTasks = local.Tasks;
  ExportedEvents = local.Events;
  ExportedPushSubscriptions = local.PushSubscriptions;
  ExportedTaskOccurrences = local.TaskOccurrences;
}

export {
  ExportedTasks as Tasks,
  ExportedEvents as Events,
  ExportedPushSubscriptions as PushSubscriptions,
  ExportedTaskOccurrences as TaskOccurrences,
};
