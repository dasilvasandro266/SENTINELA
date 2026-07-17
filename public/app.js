import ActiveDocumentsManager from '/active-documents/ActiveDocumentsManager.js';
import ActiveDocumentsUI from '/active-documents/ActiveDocumentsUI.js';
import ActiveDocumentsRestorer from '/active-documents/ActiveDocumentsRestorer.js';

const ROUTES = {
  "/app/home": {
    html: "/home.html",
    module: "/routes/home.js",
    fallbackTitle: "SENTINELA - Home",
  },
  "/app/legislacao": {
    html: "/legislacao.html",
    module: "/routes/legislacao.js",
    fallbackTitle: "SENTINELA - Legislação",
  },
  "/app/jurisprudencia": {
    html: "/jurisprudencia.html",
    module: "/routes/jurisprudencia.js",
    fallbackTitle: "SENTINELA - Jurisprudência",
  },
  "/app/reader": {
    html: "/leitor.html",
    module: "/routes/reader.js",
    fallbackTitle: "SENTINELA - Leitor Jurídico",
  },
  "/app/perfil": {
    html: "/perfil.html",
    module: "/perfil.js",
    fallbackTitle: "SENTINELA - Perfil",
  },
  "/app/acerca": {
    html: "/acerca.html",
    module: "/acerca.js",
    fallbackTitle: "SENTINELA - Acerca",
  },
  "/app/termos": {
    html: "/termos.html",
    module: "/legal.js",
    fallbackTitle: "SENTINELA - Termos",
  },
  "/app/privacidade": {
    html: "/privacidade.html",
    module: "/legal.js",
    fallbackTitle: "SENTINELA - Privacidade",
  },
  "/app/contacto": {
    html: "/contacto.html",
    module: "/legal.js",
    fallbackTitle: "SENTINELA - Contacto",
  },
};

const BASE_STYLE_HREFS = new Set(["anime-nav.css"]);
let activeStyleLinks = [];
let activeDocumentsManager = null;
let activeDocumentsUI = null;
let activeDocumentsRestorer = null;

function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || window.location.search.includes('standalone=true');
}

async function initializeActiveDocuments() {
  if (!isStandalonePWA()) return;
  activeDocumentsManager = await ActiveDocumentsManager.getInstance();
  activeDocumentsUI = new ActiveDocumentsUI(activeDocumentsManager);
  await activeDocumentsUI.mount();
  activeDocumentsRestorer = new ActiveDocumentsRestorer(activeDocumentsManager, activeDocumentsUI);
  await activeDocumentsRestorer.init();
}

function normalizePath(pathname) {
  if (!pathname) return "/app/home";
  const pathOnly = pathname.split(/[?#]/)[0];
  if (pathOnly === "/" || pathOnly === "") return "/app/home";
  if (pathOnly === "/app" || pathOnly === "/app/") return "/app/home";
  if (pathOnly === "/app-shell.html" || pathOnly.endsWith("/app-shell.html")) return "/app/home";
  if (pathOnly === "/leitor.html") return "/app/reader";
  if (pathOnly.startsWith("/app/") && pathOnly.endsWith(".html")) {
    const base = pathOnly.slice(0, -5);
    return base;
  }
  return pathOnly;
}

function isSameOrigin(href) {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function normalizeNavPath(pathname) {
  if (!pathname) return "/app/home";
  const pathOnly = pathname.split(/[?#]/)[0];
  const normalized = pathOnly.replace(/\/+/g, "/").replace(/\/$/, "");
  if (normalized === "/" || normalized === "/app") return "/app/home";
  if (normalized === "/leitor.html") return "/app/reader";
  if (normalized === "/app/reader") return "/app/legislacao";
  return normalized;
}

function shouldHandleLink(anchor) {
  if (!anchor || anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  const href = anchor.getAttribute("href") || "";
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return false;
  if (!isSameOrigin(anchor.href)) return false;
  const url = new URL(anchor.href);
  if (isStandalonePWA() && url.pathname === '/leitor.html') {
    return true;
  }
  return url.pathname.startsWith("/app/") || url.pathname === "/app";
}

function setBodyMeta(doc) {
  document.title = doc.title || document.title;
  document.body.className = doc.body.className || "";
  if (doc.body.dataset && doc.body.dataset.feature) {
    document.body.dataset.feature = doc.body.dataset.feature;
  } else {
    delete document.body.dataset.feature;
  }
}

function clearRouteStyles() {
  activeStyleLinks.forEach((link) => link.remove());
  activeStyleLinks = [];
}

function addRouteStyles(hrefs) {
  clearRouteStyles();
  hrefs.forEach((href) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.routeStyle = "1";
    document.head.appendChild(link);
    activeStyleLinks.push(link);
  });
}

function extractStyles(doc) {
  const links = Array.from(doc.querySelectorAll("link[rel='stylesheet']"));
  const localHrefs = links
    .map((l) => l.getAttribute("href"))
    .filter(Boolean)
    .filter((href) => !href.startsWith("http://") && !href.startsWith("https://"))
    .filter((href) => !BASE_STYLE_HREFS.has(href))
    .map((href) => {
      if (href.startsWith("/")) return href;
      const cleaned = href.startsWith("./") ? href.slice(2) : href;
      return "/" + cleaned;
    });
  return Array.from(new Set(localHrefs));
}

function extractBodyContent(doc) {
  const container = document.createElement("div");
  Array.from(doc.body.children).forEach((node) => {
    const tag = node.tagName;
    if (tag === "HEADER" || tag === "FOOTER" || tag === "SCRIPT") return;
    container.appendChild(node.cloneNode(true));
  });
  return container.innerHTML;
}

function setActiveNav(pathname) {
  const items = document.querySelectorAll("[data-nav-item]");
  const currentActive = Array.from(items).find((item) => item.classList.contains("is-active"));
  let matched = false;
  const normalizedPath = normalizeNavPath(pathname);

  items.forEach((item) => item.classList.remove("is-active"));
  items.forEach((item) => {
    const href = item.getAttribute("href") || "";
    if (!href) return;
    try {
      const url = new URL(href, window.location.origin);
      if (normalizeNavPath(url.pathname) === normalizedPath) {
        item.classList.add("is-active");
        matched = true;
      }
    } catch {
      // ignore
    }
  });

  if (!matched && currentActive) {
    currentActive.classList.add("is-active");
  }
}

async function renderRoute(pathname) {
  const routePath = normalizePath(pathname);
  const route = ROUTES[routePath];
  if (!route) {
    if (pathname.startsWith("/app")) {
      window.location.href = "/app/home";
      return;
    }
    window.location.href = pathname;
    return;
  }
  if (routePath !== pathname) {
    window.history.replaceState({}, "", routePath);
  }

  const appContent = document.getElementById("app-content");
  appContent.innerHTML = "<main><p style=\"padding:24px;\">A carregar...</p></main>";

  let routeModule = null;
  let response;

  try {
    response = await fetch(route.html, { cache: "no-cache" });
  } catch (error) {
    console.error("Erro de rede ao carregar a rota:", error);
    appContent.innerHTML = "<main><p style=\"padding:24px;\">Não foi possível carregar a página. Verifique sua conexão.</p></main>";
    return;
  }

  if (!response.ok) {
    appContent.innerHTML = "<main><p style=\"padding:24px;\">Erro ao carregar a página.</p></main>";
    return;
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  if (!doc || !doc.body) {
    appContent.innerHTML = "<main><p style=\"padding:24px;\">Conteúdo inválido.</p></main>";
    return;
  }

  setBodyMeta(doc);
  addRouteStyles(extractStyles(doc));
  appContent.innerHTML = extractBodyContent(doc);
  setActiveNav(routePath);
  window.scrollTo(0, 0);

  try {
    routeModule = await import(route.module);
  } catch (error) {
    console.error("Erro ao importar módulo de rota:", error);
    appContent.innerHTML = "<main><p style=\"padding:24px;\">Erro ao carregar o módulo da página.</p></main>";
    return;
  }

  document.dispatchEvent(new Event("DOMContentLoaded"));
}

function handleLinkClick(event) {
  const anchor = event.target.closest("a");
  if (!shouldHandleLink(anchor)) return;
  event.preventDefault();
  const url = new URL(anchor.href);
  navigate(url.pathname + url.search);
}

function navigate(pathname) {
  const routePath = normalizePath(pathname);
  const currentLocation = window.location.pathname + window.location.search;
  if (pathname !== currentLocation) {
    window.history.pushState({}, "", pathname);
  }
  renderRoute(pathname).catch((error) => {
    console.error("Erro ao renderizar rota:", error);
  });
}

window.addEventListener("popstate", () => {
  renderRoute(window.location.pathname + window.location.search).catch((error) => {
    console.error("Erro ao renderizar rota:", error);
  });
});

document.addEventListener("click", handleLinkClick);

renderRoute(window.location.pathname).catch((error) => {
  console.error("Erro ao renderizar rota:", error);
});

initializeActiveDocuments().catch((error) => {
  console.error("Erro ao inicializar Documentos Activos:", error);
});
