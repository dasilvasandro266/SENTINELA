/* ======================================================================
   SIDEBAR.JS
   Componente de navegação partilhado entre páginas.
   Uso:
     import Sidebar from "/components/Sidebar/Sidebar.js";
     await Sidebar.mount();
   ====================================================================== */

// Resolve caminhos relativos a este ficheiro, independentemente da
// profundidade da página que o importa.
const SIDEBAR_BASE = new URL('.', import.meta.url).href;

const state = {
  mounted: false,
  navEl: null,
};

function normalizeFileName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizePath(path) {
  if (!path) return 'home.html';
  const clean = String(path).replace(/[#?].*$/, '').replace(/\/$/, '');
  const name = clean.split('/').pop() || 'home.html';
  return normalizeFileName(decodeURIComponent(name));
}

function injectStyles() {
  if (document.querySelector('link[data-sidebar-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${SIDEBAR_BASE}Sidebar.css`;
  link.setAttribute('data-sidebar-styles', '');
  document.head.appendChild(link);
}

function markActiveItem(nav) {
  const items = Array.from(nav.querySelectorAll('[data-nav-item]'));
  if (!items.length) return;

  const current = normalizePath(window.location.pathname);
  let activeItem = items.find(
    (item) => normalizeFileName(item.getAttribute('href') || '') === current
  );

  if (!activeItem) {
    activeItem = items.find((item) => item.classList.contains('is-active')) || items[0];
  }

  items.forEach((item) => item.classList.remove('is-active'));
  activeItem.classList.add('is-active');
}

/**
 * Monta a sidebar e injeta-a no DOM.
 * @param {Object} [options]
 * @param {string} [options.target] - Seletor do elemento onde inserir (default: document.body, como primeiro filho).
 * @returns {Promise<HTMLElement>} o elemento <nav> montado.
 */
async function mount(options = {}) {
  if (state.mounted && state.navEl) return state.navEl;

  injectStyles();

  const response = await fetch(`${SIDEBAR_BASE}Sidebar.html`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Sidebar: falha ao carregar Sidebar.html (HTTP ${response.status})`);
  }
  const html = await response.text();

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  const nav = wrapper.firstElementChild;

  const target = options.target ? document.querySelector(options.target) : document.body;
  if (!target) {
    throw new Error('Sidebar: elemento alvo não encontrado.');
  }
  target.insertBefore(nav, target.firstChild);

  document.body.classList.add('has-sidebar');

  markActiveItem(nav);
  window.addEventListener('popstate', () => markActiveItem(nav));

  state.mounted = true;
  state.navEl = nav;
  return nav;
}

/** Devolve o elemento <nav> montado (ou null se ainda não montado). */
function getElement() {
  return state.navEl;
}

export default { mount, getElement };
