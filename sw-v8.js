const CACHE_VERSION = 'v8';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      return self.clients.claim();
    }).then(function() {
      return self.clients.matchAll({ type: 'window' }).then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'SW_UPDATED' });
        });
      });
    })
  );
});

// index.htmlは常にネットワークから取得（キャッシュしない）
self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }
});

self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'ShiftLink';
  const options = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
