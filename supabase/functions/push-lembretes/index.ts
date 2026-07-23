// Edge Function: roda via cron (pg_cron) a cada N minutos (ver supabase/schema.sql
// ou o comando cron.schedule mencionado no README para o schedule exato).
//
// Comportamento:
//  - Antes das 21h: aviso único (dedup via push_log) quando uma tarefa vence hoje,
//    e aviso único quando um compromisso está a até 20min de começar.
//  - A partir das 21h: "cobrança" insistente — se ainda existir tarefa com
//    due_date = hoje e done = false, reenvia a notificação em TODA execução do
//    cron (sem dedup), até o usuário marcar todas como concluídas no app.
//
// Envio de push implementado manualmente com a Web Crypto API nativa do Deno
// (RFC 8291 aes128gcm + RFC 8292 VAPID), em vez do pacote npm "web-push": esse
// pacote depende de crypto.createSign/createECDH do Node, e a camada de
// compatibilidade Node do Supabase Edge Runtime gera uma assinatura ECDSA
// inválida, causando "invalid JWT provided" (403) do FCM em toda tentativa
// mesmo com as chaves corretas — confirmado comparando com um envio idêntico
// via Node.js puro, que funcionou.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;

const TIMEZONE = 'America/Sao_Paulo';
const NAG_START_HOUR = 21;

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

// ---------- Web Push (VAPID + aes128gcm) implementado com Web Crypto nativa ----------

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(sig);
}

// HKDF-Expand simplificado (RFC 5869) para saídas de até 32 bytes — o suficiente
// para as chaves derivadas usadas aqui (16 e 12 bytes).
async function hkdfExpandOneRound(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const t = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return t.slice(0, length);
}

async function importVapidPrivateKey(publicKeyB64url: string, privateKeyB64url: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKeyB64url); // 0x04 || x(32) || y(32)
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToB64url(b64urlToBytes(privateKeyB64url)),
    x: bytesToB64url(x),
    y: bytesToB64url(y),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidAuthHeader(endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  };
  const encoder = new TextEncoder();
  const headerB64 = bytesToB64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await importVapidPrivateKey(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(signingInput),
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;

  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

/** Criptografa o payload conforme RFC 8291 (aes128gcm) para um destinatário Web Push. */
async function encryptPayload(p256dhB64url: string, authB64url: string, plaintext: string) {
  const uaPublicRaw = b64urlToBytes(p256dhB64url);
  const authSecret = b64urlToBytes(authB64url);

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256),
  );

  const encoder = new TextEncoder();
  const authInfo = concatBytes(encoder.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const prkKey = await hmacSha256(authSecret, sharedSecret);
  const ikm = await hkdfExpandOneRound(prkKey, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpandOneRound(prk, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpandOneRound(prk, encoder.encode('Content-Encoding: nonce\0'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintextBytes = concatBytes(encoder.encode(plaintext), new Uint8Array([2])); // delimitador de registro único
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintextBytes),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw);

  return concatBytes(header, ciphertext);
}

async function sendWebPush(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: unknown) {
  const body = await encryptPayload(subscription.keys.p256dh, subscription.keys.auth, JSON.stringify(payload));
  const authHeader = await buildVapidAuthHeader(subscription.endpoint);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`push falhou (${res.status}): ${text}`);
  }
}

async function sendToAllSubscriptions(subscriptions: any[], payload: { title: string; body: string }, errors: string[]) {
  for (const sub of subscriptions) {
    try {
      await sendWebPush(sub.subscription, payload);
    } catch (err) {
      const msg = `sub#${sub.id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error('push falhou para uma inscrição:', msg);
      errors.push(msg);
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
  const errors: string[] = [];

  if (currentHour >= NAG_START_HOUR) {
    // Cobrança insistente: sem dedup, repete a cada execução do cron enquanto
    // existir tarefa aberta com prazo hoje.
    const openTasks = await rest(`tasks?select=id,title&due_date=eq.${today}&done=eq.false`);

    if (openTasks.length > 0) {
      const body = openTasks.length === 1
        ? `"${openTasks[0].title}" ainda está pendente hoje!`
        : `Você ainda tem ${openTasks.length} tarefas pendentes hoje!`;

      await sendToAllSubscriptions(subscriptions, { title: '⏰ Pendências do dia', body }, errors);
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
      await sendToAllSubscriptions(subscriptions, { title: notif.title, body: notif.body }, errors);
      await restPost('push_log', notif.kind === 'task' ? { task_id: notif.id } : { event_id: notif.id });
      sentCount += 1;
    }
  }

  return new Response(
    JSON.stringify({ sent: sentCount, subscriptions: subscriptions.length, errors }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
