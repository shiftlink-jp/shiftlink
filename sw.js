const CACHE_VERSION = 'v15';
const SUPABASE_URL = 'https://qgcgkrcrfzonmmygcdju.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnY2drcmNyZnpvbm1teWdjZGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxOTY3NDcsImV4cCI6MjA5MDc3Mjc0N30.2kTAP333XfchMUpOJQB-Ex44wdj51JqjJR9nyTboBPE';
const VAPID_KEY = 'BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E';

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
  var url = new URL(event.request.url);
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
  var data = event.data ? event.data.json() : {};
  var title = data.title || 'ShiftLink';
  var options = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetPath = '/index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        var p = new URL(client.url).pathname;
        if ((p === targetPath || p === '/') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetPath);
    })
  );
});

// ★ ブラウザがPush subscriptionを自動更新した場合、DBも更新する
self.addEventListener('pushsubscriptionchange', function(event) {
  console.log('[SW] pushsubscriptionchange detected');
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_KEY)
    }).then(function(newSub) {
      var newJson = newSub.toJSON();
      var oldEndpoint = event.oldSubscription ? event.oldSubscription.endpoint : null;
      // 古いsubscriptionをDBから削除
      var deletePromise = oldEndpoint
        ? supabaseRest('DELETE', '/rest/v1/push_subscriptions?subscription->>endpoint=eq.' + encodeURIComponent(oldEndpoint))
        : Promise.resolve();
      return deletePromise.then(function() {
        // メインスレッドにcast_idを問い合わせて新しいsubscriptionを登録
        return self.clients.matchAll({ type: 'window' }).then(function(clients) {
          if (clients.length > 0) {
            // メインスレッドに新subscription情報を送って登録させる
            clients.forEach(function(client) {
              client.postMessage({ type: 'PUSH_SUB_CHANGED', subscription: newJson });
            });
          }
        });
      });
    }).catch(function(e) {
      console.error('[SW] pushsubscriptionchange handling failed:', e);
    })
  );
});

// Supabase REST API直接呼び出し
function supabaseRest(method, path, body) {
  var opts = {
    method: method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(SUPABASE_URL + path, opts);
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
