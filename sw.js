/* 유앤아이의원 가격 추적 서비스 워커.
   index.html을 만들 때 캐시 이름과 미리 받을 파일 목록(c924da0fa0, ["./", "./index.html", "./assets/style.css?v=d1948f17fe", "./assets/app.js?v=d1948f17fe", "./assets/vendor/chart.umd.min.js?v=d1948f17fe", "./assets/data.js?v=d27fb956d5", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"])을
   채워 넣는다. 해시가 붙은 자산은 캐시에서 바로 쓰고, 페이지는 네트워크를 먼저 본다. */
const CACHE = "price-tracker-c924da0fa0";
const PRECACHE = ["./", "./index.html", "./assets/style.css?v=d1948f17fe", "./assets/app.js?v=d1948f17fe", "./assets/vendor/chart.umd.min.js?v=d1948f17fe", "./assets/data.js?v=d27fb956d5", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"];
const OFFLINE_URL = "./";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE || key.indexOf("price-tracker-") !== 0 ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isStaticAsset(url) {
  return url.pathname.indexOf("/assets/") !== -1 || url.pathname.indexOf("/icons/") !== -1;
}

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 페이지는 네트워크 우선. 실패하면 마지막으로 받은 페이지를 보여 준다.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(function (response) {
        const copy = response.clone();
        // 검색어·필터 쿼리마다 캐시가 쌓이지 않도록 경로만 키로 쓴다.
        caches.open(CACHE).then(function (cache) { cache.put(url.pathname, copy); });
        return response;
      }).catch(function () {
        return caches.match(url.pathname)
          .then(function (cached) { return cached || caches.match(OFFLINE_URL) || caches.match("./index.html"); });
      })
    );
    return;
  }

  // 해시가 붙은 정적 자산은 캐시 우선. 없으면 받아서 저장한다.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        });
      })
    );
  }
});
