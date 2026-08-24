const CACHE_NAME = 'agenda-obsidian-v7';
const CORE_ASSETS = ['/index.html', '/style.css', '/js/app.js', '/js/supabase-client.js', '/js/markdown-parser.js', '/js/fs-obsidian.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: sempre busca a versão mais nova primeiro, só usa o cache como
// fallback offline. Evita servir HTML/CSS/JS desatualizados durante o desenvolvimento.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Notificações push disparadas pela Edge Function push-lembretes
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Agenda', body: 'Você tem algo pendente.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Vibração explícita: 3 pulsos de 500ms com pausa de 1s entre eles —
      // sem isso alguns Android tratam a notificação como silenciosa mesmo
      // com o canal do sistema permitindo som/vibração.
      vibrate: [500, 1000, 500, 1000, 500],
      requireInteraction: true,
      data: { url: data.url || '/index.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/index.html'));
});
