const CACHE_VERSION = 'v26';
// #8: SWからの直接DB書き込み(anon鍵)を廃止したため SUPABASE_URL / SUPABASE_KEY は不要に。
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
      // #8: SWはanon鍵でDBを直接書かない（anon遮断後に失敗するため）。
      // 新subの登録も旧subの削除も、ログイン済みセッションを持つメインスレッドに委譲する。
      // メインスレッドが閉じている場合の旧sub残りは send-push の失効購読クリーンアップが回収する。
      return self.clients.matchAll({ type: 'window' }).then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'PUSH_SUB_CHANGED', subscription: newJson, oldEndpoint: oldEndpoint });
        });
      });
    }).catch(function(e) {
      console.error('[SW] pushsubscriptionchange handling failed:', e);
    })
  );
});

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
