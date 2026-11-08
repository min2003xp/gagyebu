// 서비스 워커: 홈 화면 앱 설치, 인터넷이 잠깐 끊겼을 때 화면 열기, 푸시 알림 받기

const CACHE = 'gagyebu-v2';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'store.js', 'cloud-store.js', 'digest.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 앱 파일은 '인터넷 먼저, 안 되면 저장해 둔 것' → 업데이트가 바로 반영된다
// (no-cache: 브라우저가 10분 동안 들고 있는 옛 파일 대신 서버에 새 버전이 있는지 꼭 확인)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./'))),
  );
});

// 요약 알림 받기
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '우리집 가계부', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'gagyebu-digest',
    renotify: true,
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(e.notification.data?.url || './');
    }),
  );
});
