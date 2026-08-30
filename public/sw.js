/* YUKTI Beat PWA service worker — offline shell + IndexedDB-friendly cache */
const CACHE = 'yukti-beat-v1'
const PRECACHE = ['/', '/beat', '/manifest.webmanifest', '/beat-icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api')) {
    event.respondWith(
      fetch(req)
        .then((res) => res)
        .catch(async () => {
          const cached = await caches.match(req)
          return cached || new Response(JSON.stringify({ success: false, offline: true }), { headers: { 'Content-Type': 'application/json' } })
        }),
    )
    return
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone()
      caches.open(CACHE).then((c) => c.put(req, copy))
      return res
    }).catch(() => caches.match('/beat') || caches.match('/'))),
  )
})
