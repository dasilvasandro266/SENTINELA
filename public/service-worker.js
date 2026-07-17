// ===============================
// SENTINELA 4.0 SERVICE WORKER
// ===============================

const CACHE_VERSION = "v4.0-" + new Date().toISOString().slice(0, 10);
const CACHE_NAME = `sentinela-cache-${CACHE_VERSION}`;
const DEBUG = false;

// -------------------------------
// Arquivos essenciais locais
// -------------------------------
const localAssets = [
  '/',
  '/app-shell.html',
  '/home.html',
  '/routes/home.js',
  '/index.html',
  '/jurisprudencia.html',
  '/jurisprudencia.js',
  '/legislacao.html',
  '/routes/legislacao.js',
  '/admin/admin.html',
  '/admin/admin.css',
  '/admin/admin.js',
  '/perfil.html',
  '/perfil.css',
  '/perfil.js',
  '/leitor.html',
  '/leitor.js',
  '/firebase-config.js',
  '/favicon.ico',
  '/manifest.json',
  '/offline.html',
  '/images/apple-touch-icon.png',
  '/images/android-chrome-192x192.png',
  '/images/android-chrome-512x512.png',
  '/pwa-install.css',
  '/pwa-install.js'
];

// -------------------------------
// CDN de terceiros a cachear
// -------------------------------
const cdnAssets = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2'
];

const urlsToCache = [...localAssets, ...cdnAssets];

// -------------------------------
// Instalação (instala e pré-cacheia)
// -------------------------------
self.addEventListener("install", (event) => {
  if (DEBUG) console.log("[SW] Instalando nova versão...");

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        if (DEBUG) console.log("[SW] Cacheando arquivos essenciais...");

        await cache.addAll(localAssets);

        // Cacheia recursos CDN do Font Awesome
        for (let url of cdnAssets) {
          try {
            const response = await fetch(url, { mode: "no-cors" });
            await cache.put(url, response);
            if (DEBUG) console.log("[SW] Cacheado CDN:", url);
          } catch (e) {
            console.warn("[SW] Falha ao cachear CDN:", url, e);
          }
        }
      })
      .then(() => {
        // Força o SW a entrar em vigor imediatamente
        self.skipWaiting();
      })
      .catch(err => console.error("[SW] Erro ao armazenar arquivos:", err))
  );
});

// -------------------------------
// Ativação (limpa caches antigos)
// -------------------------------
self.addEventListener("activate", (event) => {
  if (DEBUG) console.log("[SW] Ativando nova versão...");

  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            if (DEBUG) console.log("[SW] Excluindo cache antigo:", cacheName);
            return caches.delete(cacheName);
          }
        })
      )
    ).then(() => {
      // Assume controle imediato das páginas abertas
      return self.clients.claim();
    })
  );
});

// -------------------------------
// Estratégia Network-First (com fallback offline)
// -------------------------------
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestURL = new URL(event.request.url);

  // Ignora extensões e protocolos não suportados
  if (
    requestURL.protocol.startsWith("chrome-extension") ||
    requestURL.protocol.startsWith("chrome") ||
    requestURL.protocol.startsWith("about") ||
    requestURL.protocol.startsWith("blob")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => {
          if (cached) return cached;

          const requestURL = new URL(event.request.url);
          const isNavigation = event.request.destination === "document" || event.request.mode === "navigate";
          const isAppRoute = requestURL.pathname.startsWith('/app') || requestURL.pathname === '/app-shell.html';

          if (isNavigation && isAppRoute) {
            return caches.match('/app-shell.html').then((fallback) => fallback || caches.match('/offline.html'));
          }

          if (isNavigation) {
            return caches.match('/offline.html');
          }

          if (event.request.url.endsWith('manifest.json')) {
            return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
          }

          return new Response('Conteúdo indisponível offline.', {
            status: 503,
            statusText: 'Offline'
          });
        });
      })
  );
});

// -------------------------------
// Atualização silenciosa (automática)
// -------------------------------
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
