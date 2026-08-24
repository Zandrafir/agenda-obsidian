-- Rode isso no SQL Editor do seu projeto Supabase.

create table if not exists tasks (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  due_date date,
  tags text[] not null default '{}',
  source text not null default 'manual' check (source in ('manual', 'obsidian')),
  source_file text,
  line_number int,
  recurrence_days int[], -- dias da semana (0=domingo ... 6=sábado); null = tarefa avulsa
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_file, line_number)
);

-- Uma linha por (tarefa recorrente, dia concreto) só quando marcada como feita —
-- evita duplicar a tarefa em si, só rastreia a conclusão por ocorrência.
create table if not exists task_occurrences (
  id bigint generated always as identity primary key,
  task_id bigint not null references tasks(id) on delete cascade,
  occurrence_date date not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, occurrence_date)
);

create table if not exists events (
  id bigint generated always as identity primary key,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  notes text,
  remind_before_minutes int[] not null default '{}', -- lembretes extras (em minutos) antes do início
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  unique (subscription)
);

create table if not exists push_log (
  id bigint generated always as identity primary key,
  task_id bigint references tasks(id) on delete cascade,
  event_id bigint references events(id) on delete cascade,
  reminder_offset int, -- minutos antes do evento (null = aviso "em breve" padrão)
  sent_at timestamptz not null default now()
);

-- RLS aberta na fase 1 (mesmo padrão usado no projeto gestao-diario) — revisar antes de expor publicamente.
alter table tasks enable row level security;
alter table events enable row level security;
alter table push_subscriptions enable row level security;
alter table push_log enable row level security;
alter table task_occurrences enable row level security;

create policy "acesso_total_fase1" on tasks for all using (true) with check (true);
create policy "acesso_total_fase1" on events for all using (true) with check (true);
create policy "acesso_total_fase1" on push_subscriptions for all using (true) with check (true);
create policy "acesso_total_fase1" on push_log for all using (true) with check (true);
create policy "acesso_total_fase1" on task_occurrences for all using (true) with check (true);
