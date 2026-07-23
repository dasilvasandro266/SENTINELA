/* ======================================================================
   FOOTER.JS
   Rodapé partilhado entre páginas.
   Uso:
     import Footer from "/components/Footer/Footer.js";
     await Footer.mount();
   ====================================================================== */

// Resolve caminhos relativos a este ficheiro, independentemente da
// profundidade da página que o importa.
const FOOTER_BASE = new URL('.', import.meta.url).href;

const state = {
  mounted: false,
  footerEl: null,
};

function injectStyles() {
  if (document.querySelector('link[data-footer-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${FOOTER_BASE}Footer.css`;
  link.setAttribute('data-footer-styles', '');
  document.head.appendChild(link);
}

/**
 * Monta o footer e injeta-o no DOM.
 * @param {Object} [options]
 * @param {string} [options.target] - Seletor do elemento onde inserir (default: document.body, como último filho).
 * @returns {Promise<HTMLElement>} o elemento <footer> montado.
 */
async function mount(options = {}) {
  if (state.mounted && state.footerEl) return state.footerEl;

  injectStyles();

  const response = await fetch(`${FOOTER_BASE}Footer.html`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Footer: falha ao carregar Footer.html (HTTP ${response.status})`);
  }
  const html = await response.text();

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  const footer = wrapper.firstElementChild;

  const target = options.target ? document.querySelector(options.target) : document.body;
  if (!target) {
    throw new Error('Footer: elemento alvo não encontrado.');
  }
  target.appendChild(footer);

  state.mounted = true;
  state.footerEl = footer;
  return footer;
}

/** Devolve o elemento <footer> montado (ou null se ainda não montado). */
function getElement() {
  return state.footerEl;
}

export default { mount, getElement };
