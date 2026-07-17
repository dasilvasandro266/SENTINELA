// jurisprudencia.js - Rota de inicialização para jurisprudência em PWA
// Re-exporta e inicializa funcionalidades do jurisprudencia.js principal

import { authenticatedFetch, getUser, isAdminUser } from "../authManager.js";

const API_URL = "/api";

let jurisprudenciaContainer = null;
let searchInput = null;
let loadingAnimation = null;
let todasJurisprudencias = [];
let userIsAdmin = false;

function getJurisprudenciaContainer() {
  return document.querySelector(".jurisprudencia-container, .jurisprudência-container");
}

function getSearchInput() {
  return document.getElementById("search-bar") || document.getElementById("searchInput");
}

// Básico: carregar jurisprudências
async function carregarJurisprudencias() {
  try {
    const response = await authenticatedFetch(`${API_URL}/jurisprudencias`);
    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }
    const jurisprudencias = await response.json();
    todasJurisprudencias = jurisprudencias;
    renderizarJurisprudencias(jurisprudencias);
    console.log("✅ Jurisprudências carregadas:", jurisprudencias.length);
  } catch (error) {
    console.error("❌ Erro ao carregar jurisprudências:", error);
    const cache = localStorage.getItem('jurisprudencias_cache');
    if (cache) {
      try {
        todasJurisprudencias = JSON.parse(cache);
        renderizarJurisprudencias(todasJurisprudencias);
        console.log("📦 Usando cache local");
      } catch (e) {
        if (jurisprudenciaContainer) {
          jurisprudenciaContainer.innerHTML = "<p class='empty'>Erro ao carregar jurisprudências. O servidor está rodando?</p>";
        }
      }
    } else {
      if (jurisprudenciaContainer) {
        jurisprudenciaContainer.innerHTML = "<p class='empty'>Erro ao carregar jurisprudências. Verifique se o servidor está rodando.</p>";
      }
    }
  } finally {
    if (loadingAnimation) {
      loadingAnimation.style.display = 'none';
      document.body.classList.remove('no-content');
    }
    if (jurisprudenciaContainer) {
      jurisprudenciaContainer.style.display = 'grid';
    }
  }
}

function renderizarJurisprudencias(lista = []) {
  if (!jurisprudenciaContainer) return;
  
  // Limpar
  const itemsToRemove = jurisprudenciaContainer.querySelectorAll('.jurisprudencia-item, .empty');
  itemsToRemove.forEach(el => el.remove());

  if (!lista || lista.length === 0) {
    jurisprudenciaContainer.innerHTML += "<p class='empty'>Nenhuma jurisprudência disponível.</p>";
    return;
  }

  localStorage.setItem('jurisprudencias_cache', JSON.stringify(lista));

  lista.forEach(({ id, tribunal, ano, nome }) => {
    const div = document.createElement("div");
    div.className = "jurisprudencia-item";
    div.innerHTML = `
      <h3>${nome || `${tribunal} - ${ano}`}</h3>
      <p class="meta">${tribunal} (${ano})</p>
    `;

    div.addEventListener("click", () => {
      if (!id) return;
      localStorage.setItem("jurisprudenciaAtual", id);
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true
        || window.location.search.includes('standalone=true');
      if (isStandalone) {
        window.location.href = `/app/reader?jurisprudencia=${encodeURIComponent(id)}`;
      } else {
        window.open(`/jurisprudencia.html?id=${encodeURIComponent(id)}`, "_blank");
      }
    });

    jurisprudenciaContainer.appendChild(div);
  });
}

async function initJurisprudencia() {
  try {
    const user = await getUser();
    if (!user) {
      console.error("⛔ Usuário não autenticado.");
      window.location.href = "/index.html";
      return;
    }

    jurisprudenciaContainer = getJurisprudenciaContainer();
    searchInput = getSearchInput();
    loadingAnimation = document.getElementById("loadingAnimation");

    if (!jurisprudenciaContainer) {
      console.error("⛔ Container não encontrado!");
      return;
    }

    userIsAdmin = isAdminUser(user);
    console.log("✅ Inicialização de jurisprudência completa");

    await carregarJurisprudencias();
  } catch (error) {
    console.error("Erro durante inicialização:", error);
    if (jurisprudenciaContainer) {
      jurisprudenciaContainer.innerHTML = "<p class='empty'>Erro ao carregar. Verifique se o servidor está rodando.</p>";
    }
  }
}

// Inicializar quando documento estiver pronto
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initJurisprudencia);
} else {
  initJurisprudencia();
}
