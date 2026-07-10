/* IKVIZZ service worker — Web Push delivery (Phase 9) + install support.
   The payload arrives already decrypted by the browser (RFC 8291);
   we just show it and focus the app on click. No Apple/APNs here. */

// Take control promptly so the app is installable and controlled on first load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// A minimal pass-through fetch handler — required for install criteria. We do
// NOT cache (the app is realtime/local-first); we just proxy to the network and
// fall back to the app shell only if the network genuinely fails. IMPORTANT:
// always resolve to a real Response — never `undefined` (that renders a blank
// page). `caches.match` returns a Promise, so it must be awaited, not `||`-ed.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch {
      return (await caches.match('/')) || fetch('/');
    }
  })());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* opaque push */ }
  event.waitUntil(self.registration.showNotification(data.title || 'IKVIZZ', {
    body: data.body || '',
    tag: 'aether-' + (data.kind || 'note'),
    data: data.data || {},
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const convo = event.notification.data?.conversationId;
  const url = convo ? `/#/chat/${convo}` : '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
