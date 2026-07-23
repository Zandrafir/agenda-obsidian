# Agenda + Obsidian (PWA)

## Arquitetura

- **Front-end**: HTML/CSS/JS puro (sem build step), módulos ES nativos. Visual baseado no design system
  "Ponte" (cards escuros, abas em pílula, checkbox animado).
- **Dados**: Supabase (Postgres + REST via PostgREST + Edge Functions para push). Enquanto as credenciais
  não são preenchidas em `js/supabase-client.js`, o app usa `js/local-store.js` (localStorage) como
  fallback automático — dá pra testar tudo sem backend.
- **Leitura do Obsidian**: File System Access API do navegador (Chrome/Edge) — você escolhe a pasta do
  vault uma vez, o app lê todos os `.md` recursivamente e também escreve de volta quando você marca uma
  tarefa como concluída pelo app.
- **Push**: Web Push padrão + Edge Function `push-lembretes` rodando em cron (pg_cron).

## Estrutura de arquivos

```
agenda-obsidian/
├── index.html
├── style.css
├── manifest.json
├── sw.js
├── js/
│   ├── app.js               # lógica principal, renderização, forms, recorrência, reagendamento
│   ├── supabase-client.js    # wrapper REST do Supabase (ou local-store.js como fallback)
│   ├── local-store.js        # fallback localStorage (mesma interface do supabase-client)
│   ├── markdown-parser.js    # parsing de "- [ ] tarefa #tag 📅 data"
│   └── fs-obsidian.js        # File System Access API (ler/escrever vault)
└── supabase/
    ├── schema.sql            # tasks, events, task_occurrences, push_subscriptions, push_log
    └── functions/push-lembretes/index.ts
```

## Setup

1. **Criar projeto Supabase** (supabase.com) e rodar `supabase/schema.sql` no SQL Editor.
2. Copiar a **URL** e a **anon key** do projeto para `js/supabase-client.js`.
3. Gerar chaves VAPID para push:
   ```bash
   npx web-push generate-vapid-keys
   ```
   Colar a pública em `js/app.js` (`VAPID_PUBLIC_KEY`).
4. Deploy da Edge Function:
   ```bash
   supabase functions deploy push-lembretes
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:seu@email.com
   ```
5. Agendar via `pg_cron` no SQL Editor — uma execução a cada 5 minutos, o dia todo. A própria função decide
   internamente se é aviso único (antes das 21h) ou cobrança insistente (a partir das 21h, horário de
   São Paulo):
   ```sql
   select cron.schedule(
     'push-lembretes-agenda',
     '*/5 * * * *',
     $$
     select net.http_post(
       url := 'https://SEU-PROJETO.supabase.co/functions/v1/push-lembretes',
       headers := '{"Authorization": "Bearer SUA-SERVICE-ROLE-KEY"}'::jsonb
     );
     $$
   );
   ```
6. Servir os arquivos estáticos (qualquer servidor http, ex: `npx serve .`) — **precisa ser via
   http(s)/localhost**, File System Access API e Service Worker não funcionam abrindo o `index.html`
   direto do disco (`file://`).

## Uso

- **Tarefa / Compromisso**: abas em pílula filtram a lista única entre tarefas e compromissos.
- **Repetir**: ao criar uma tarefa, selecione os dias da semana no seletor "Repetir" para torná-la
  recorrente — ela passa a aparecer automaticamente nesses dias, sem precisar recriar. A conclusão é
  rastreada por dia (`task_occurrences`), então marcar "feito" numa segunda não afeta a próxima quarta.
- **Reagendar**: clique no ícone ✎ de uma tarefa avulsa ou compromisso para abrir um campo de data (e hora,
  no caso de compromisso) e mudar o prazo direto no banco. Tarefas recorrentes não têm esse botão (não
  fazem sentido reagendar, já que repetem por dia da semana).
- **Vault**: conecta a pasta do Obsidian e sincroniza tarefas em `- [ ] texto #tag 📅 2026-07-25`. Marcar
  uma tarefa vinda do Obsidian como concluída também reescreve o checkbox (`[x]`) no arquivo `.md` original.
- **Notificações**: ativa push do navegador. A partir das 21h, se ainda houver tarefa com prazo hoje e não
  concluída, chega uma notificação a cada ~5 minutos até você marcar tudo como feito.

## Limitações conhecidas

- File System Access API só funciona em Chrome/Edge desktop e Android; no iOS Safari não há suporte —
  nesse caso a alternativa é upload manual do `.md` (fácil de adicionar depois, reaproveitando
  `markdown-parser.js`).
- A permissão de pasta pode precisar ser reconfirmada pelo navegador de tempos em tempos (comportamento
  do browser, não do app).
- RLS das tabelas está aberta (`acesso_total_fase1`) — revisar antes de expor a URL publicamente.
- O service worker usa estratégia network-first e recarrega a página sozinho quando uma nova versão assume
  o controle (`controllerchange`), para evitar ficar preso em cache antigo durante o desenvolvimento.
