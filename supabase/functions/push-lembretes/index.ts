// Edge Function: roda via cron (pg_cron) a cada N minutos (ver supabase/schema.sql
// ou o comando cron.schedule mencionado no README para o schedule exato).
//
// Comportamento:
//  - Antes das 21h: aviso único (dedup via push_log) quando uma tarefa vence hoje,
//    e aviso único quando um compromisso está a até 20min de começar.
//  - A partir das 21h: "cobrança" insistente — se ainda existir tarefa com
//    due_date = hoje e done = false, reenvia a notificação em TODA execução do
//    cron (sem dedup), até o usuário marcar todas como concluídas no app.
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;

const TIMEZONE = 'America/Sao_Paulo';
const NAG_START_HOUR = 21;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  return res.json();
}

async function restPost(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

function localDateAndHour(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { dateStr: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) };
}

async function sendToAllSubscriptions(subscriptions: any[], payload: { title: string; body: string }) {
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
    } catch (err) {
      console.error('push falhou para uma inscrição:', err);
    }
  }
}

Deno.serve(async () => {
  const now = new Date();
  const { dateStr: today, hour: currentHour } = localDateAndHour(now, TIMEZONE);
  const in20min = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
  // Início da janela no passado: cobre o caso de um evento criado com pouca
  // antecedência cujo horário já passou até o próximo tick do cron (que roda
  // a cada 5min em marcos fixos, não sob demanda na criação).
  const lookback30min = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  const subscriptions = await rest('push_subscriptions?select=id,subscription');
  let sentCount = 0;

  if (currentHour >= NAG_START_HOUR) {
    // Cobrança insistente: sem dedup, repete a cada execução do cron enquanto
    // existir tarefa aberta com prazo hoje.
    const openTasks = await rest(`tasks?select=id,title&due_date=eq.${today}&done=eq.false`);

    if (openTasks.length > 0) {
      const body = openTasks.length === 1
        ? `"${openTasks[0].title}" ainda está pendente hoje!`
        : `Você ainda tem ${openTasks.length} tarefas pendentes hoje!`;

      await sendToAllSubscriptions(subscriptions, { title: '⏰ Pendências do dia', body });
      sentCount += 1;
    }
  } else {
    // Antes das 21h: aviso único por tarefa/evento (deduplicado via push_log).
    const [dueTasks, upcomingEvents, alreadySent] = await Promise.all([
      rest(`tasks?select=id,title&due_date=eq.${today}&done=eq.false`),
      rest(`events?select=id,title,start_at&start_at=gte.${lookback30min}&start_at=lte.${in20min}`),
      rest('push_log?select=task_id,event_id'),
    ]);

    const sentTaskIds = new Set(alreadySent.map((l: any) => l.task_id).filter(Boolean));
    const sentEventIds = new Set(alreadySent.map((l: any) => l.event_id).filter(Boolean));

    const notifications = [
      ...dueTasks.filter((t: any) => !sentTaskIds.has(t.id)).map((t: any) => ({
        kind: 'task', id: t.id, title: 'Tarefa com prazo hoje', body: t.title,
      })),
      ...upcomingEvents.filter((e: any) => !sentEventIds.has(e.id)).map((e: any) => ({
        kind: 'event', id: e.id, title: 'Compromisso em breve', body: e.title,
      })),
    ];

    for (const notif of notifications) {
      await sendToAllSubscriptions(subscriptions, { title: notif.title, body: notif.body });
      await restPost('push_log', notif.kind === 'task' ? { task_id: notif.id } : { event_id: notif.id });
      sentCount += 1;
    }
  }

  return new Response(JSON.stringify({ sent: sentCount }), { headers: { 'Content-Type': 'application/json' } });
});
