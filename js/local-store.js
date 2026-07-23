/**
 * Fallback local (localStorage) usado enquanto o Supabase real não está configurado.
 * Implementa a mesma interface de Tasks/Events/PushSubscriptions do supabase-client.js,
 * para que app.js funcione sem alterações assim que as credenciais reais forem preenchidas.
 */

const KEYS = {
  tasks: 'local_tasks',
  events: 'local_events',
  push: 'local_push_subscriptions',
  occurrences: 'local_task_occurrences',
};

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function nextId(list) {
  return list.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
}

const Tasks = {
  async listAll() {
    const tasks = read(KEYS.tasks);
    return [...tasks].sort((a, b) => {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
  },

  async upsertFromObsidian(newTasks) {
    const tasks = read(KEYS.tasks);
    for (const t of newTasks) {
      const existing = tasks.find((x) => x.source_file === t.source_file && x.line_number === t.line_number);
      if (existing) {
        Object.assign(existing, t, { updated_at: new Date().toISOString() });
      } else {
        tasks.push({ id: nextId(tasks), ...t, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
    }
    write(KEYS.tasks, tasks);
    return tasks;
  },

  async createManual(task) {
    const tasks = read(KEYS.tasks);
    const record = {
      id: nextId(tasks),
      source: 'manual',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...task,
    };
    tasks.push(record);
    write(KEYS.tasks, tasks);
    return [record];
  },

  async setDone(id, done) {
    const tasks = read(KEYS.tasks);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.done = done;
      task.updated_at = new Date().toISOString();
      write(KEYS.tasks, tasks);
    }
    return [task];
  },

  async setDueDate(id, dueDate) {
    const tasks = read(KEYS.tasks);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.due_date = dueDate;
      task.updated_at = new Date().toISOString();
      write(KEYS.tasks, tasks);
    }
    return [task];
  },

  async delete(id) {
    write(KEYS.tasks, read(KEYS.tasks).filter((t) => t.id !== id));
  },
};

const Events = {
  async listAll() {
    const events = read(KEYS.events);
    return [...events].sort((a, b) => a.start_at.localeCompare(b.start_at));
  },

  async create(event) {
    const events = read(KEYS.events);
    const record = { id: nextId(events), created_at: new Date().toISOString(), ...event };
    events.push(record);
    write(KEYS.events, events);
    return [record];
  },

  async setStartAt(id, startAt) {
    const events = read(KEYS.events);
    const event = events.find((e) => e.id === id);
    if (event) {
      event.start_at = startAt;
      event.updated_at = new Date().toISOString();
      write(KEYS.events, events);
    }
    return [event];
  },

  async delete(id) {
    write(KEYS.events, read(KEYS.events).filter((e) => e.id !== id));
  },
};

const PushSubscriptions = {
  async save(subscription) {
    const subs = read(KEYS.push);
    subs.push(subscription);
    write(KEYS.push, subs);
  },
};

const TaskOccurrences = {
  async listForDate(date) {
    return read(KEYS.occurrences).filter((o) => o.occurrence_date === date);
  },

  async setDone(taskId, date, done) {
    const occurrences = read(KEYS.occurrences);
    const existing = occurrences.find((o) => o.task_id === taskId && o.occurrence_date === date);
    if (existing) {
      existing.done = done;
      existing.updated_at = new Date().toISOString();
    } else {
      occurrences.push({
        id: nextId(occurrences),
        task_id: taskId,
        occurrence_date: date,
        done,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    write(KEYS.occurrences, occurrences);
  },
};

export { Tasks, Events, PushSubscriptions, TaskOccurrences };
