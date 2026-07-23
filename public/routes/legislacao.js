import { getUser, authenticatedFetch, isAdminUser } from "/authManager.js";
import Sidebar from "/components/Sidebar/Sidebar.js";
import Footer from "/components/Footer/Footer.js";

const API_URL = '/api';

let legislacaoContainer = null;
let searchInput = null;
let loadingAnimation = null;
let todasLegislacoes = [];
let uploadLegislacaoJson = null;
let btnImportarLegislacao = null;
let importStatus = null;
let importadorLegislacao = null;
let userIsAdmin = false;

// =============================================
// FUNÇÕES DE CARREGAMENTO
// =============================================

/**
 * Carrega legislações da API local
 */
async function carregarLegislacoes() {
    try {
        const response = await authenticatedFetch(`${API_URL}/legislacoes`);
        
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        
        const legislacoes = await response.json();
        todasLegislacoes = legislacoes;
        renderizarLegislacoes(legislacoes);
        
        console.log("✅ Legislações carregadas:", legislacoes.length);
        
    } catch (error) {
        console.error("❌ Erro ao carregar legislações:", error);
        
        // Tentar carregar do cache local como fallback
        const cache = localStorage.getItem('legislacoes_cache');
        if (cache) {
            try {
                todasLegislacoes = JSON.parse(cache);
                renderizarLegislacoes(todasLegislacoes);
                console.log("📦 Usando cache local");
            } catch (e) {
                legislacaoContainer.innerHTML = "<p class='empty'>Erro ao carregar legislações. O servidor está rodando?</p>";
            }
        } else {
                legislacaoContainer.innerHTML = "<p class='empty'>Erro ao carregar legislações. Verifique se o servidor da API está disponível.</p>";
        }
    } finally {
        toggleLoading(false);
        toggleContent(true);
    }
}

/**
 * Salva lista de legislações no cache local
 */
function salvarCacheLegislacoes(legislacoes) {
    localStorage.setItem('legislacoes_cache', JSON.stringify(legislacoes));
}

// =============================================
// FUNÇÕES DE UI E UTILITÁRIOS
// =============================================

// Função para mostrar/ocultar loading
function toggleLoading(show) {
    if (loadingAnimation) {
        if (show) {
            loadingAnimation.style.display = 'flex';
            document.body.classList.add('no-content');
        } else {
            loadingAnimation.style.display = 'none';
            document.body.classList.remove('no-content');
        }
    }
}

// Função para mostrar/ocultar conteúdo
function toggleContent(show) {
    if (legislacaoContainer) {
        legislacaoContainer.style.display = show ? 'grid' : 'none';
    }
}

// Debounce utilitário
function debounce(fn, ms){
  let t; 
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), ms); };
}

// Observador para animar cards ao entrar na viewport
function setupIntersectionObserver() {
  const items = document.querySelectorAll('.legislacao-item');
  if (!items.length) return;
  
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => { 
      if (en.isIntersecting) en.target.classList.add('is-visible'); 
    });
  }, { threshold: 0.08 });
  
  items.forEach(el => io.observe(el));
}

// Destacar texto pesquisado
function enhanceHighlight() {
  const sb = document.getElementById('searchInput');
  if (!sb || sb.dataset.hl === '1') return;
  sb.dataset.hl = '1';

  const stripTags = (el, key) => {
    if (!el.dataset[key]) el.dataset[key] = el.textContent;
    el.textContent = el.dataset[key];
  };
  
  const applyMark = (el, term) => {
    if (!term) return;
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const rx = new RegExp('(' + safe + ')', 'ig');
      el.innerHTML = el.textContent.replace(rx, '<mark class="hl">$1</mark>');
    } catch (_) { /* termo pode gerar regex inválida */ }
  };

  const run = () => {
    const t = sb.value.trim();
    document.querySelectorAll('.legislacao-item').forEach(card => {
      const h = card.querySelector('h2, h3');
      if (h) {
        stripTags(h, 'origTitle');
        if (t) applyMark(h, t);
      }
    });
  };

  sb.addEventListener('input', debounce(run, 80));
  run();
}

// Persistência do termo de busca
function persistSearch() {
  const sb = document.getElementById('searchInput');
  if (!sb) return;
  const KEY = 'leg:search';
  const saved = sessionStorage.getItem(KEY);
  if (saved && !sb.value) sb.value = saved;
  sb.addEventListener('input', () => sessionStorage.setItem(KEY, sb.value || ''));
}

// Foco rápido na busca com '/'
function setupQuickSearch() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) {
      const sb = document.getElementById('searchInput');
      if (sb) { 
        e.preventDefault(); 
        sb.focus(); 
        sb.select(); 
      }
    }
  });
}

// =============================================
// FUNÇÕES PRINCIPAIS
// =============================================

function renderizarLegislacoes(lista, filtro = "") {
    // Limpar container
    const itemsToRemove = document.querySelectorAll('.legislacao-item, .empty');
    itemsToRemove.forEach(el => el.remove());

    if (!lista || lista.length === 0) {
        legislacaoContainer.innerHTML += "<p class='empty'>Nenhuma legislação disponível.</p>";
        return;
    }

    // Salvar no cache
    salvarCacheLegislacoes(lista);

    let itemsRenderizados = 0;
    
    lista.forEach(({ id, nome }) => {
        if (nome.toLowerCase().includes(filtro.toLowerCase())) {
            const div = document.createElement("div");
            div.classList.add("legislacao-item");
            div.innerHTML = `
                <h2>${nome}</h2>
                ${userIsAdmin ? `<button type="button" class="btn-eliminar-legislacao" data-legislacao-id="${id}" data-legislacao-nome="${String(nome).replace(/"/g, '&quot;')}">Eliminar</button>` : ""}
            `;

            div.addEventListener("click", () => {
                if (!id || typeof id !== "string") {
                    console.error("ID de legislação inválida:", id);
                    return;
                }
                localStorage.setItem("legislacaoAtual", id);
                
                const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true
                    || window.location.search.includes('standalone=true');
                
                if (isStandalone) {
                    window.location.href = `/app/reader?legislacao=${encodeURIComponent(id)}`;
                } else {
                    window.open(`/leitor.html?legislacao=${encodeURIComponent(id)}`, "_blank");
                }
            });

            legislacaoContainer.appendChild(div);
            itemsRenderizados++;
        }
    });

    if (userIsAdmin) {
        legislacaoContainer.querySelectorAll(".btn-eliminar-legislacao").forEach((btn) => {
            btn.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const legislacaoId = btn.getAttribute("data-legislacao-id");
                const legislacaoNome = btn.getAttribute("data-legislacao-nome") || legislacaoId;
                await eliminarLegislacaoPelaInterface(legislacaoId, legislacaoNome);
            });
        });
    }

    // Se não houver itens após o filtro
    if (itemsRenderizados === 0) {
        legislacaoContainer.innerHTML += "<p class='empty'>Nenhum resultado encontrado.</p>";
    }

    // Configurar animações e realce de pesquisa
    setupIntersectionObserver();
    enhanceHighlight();
}

async function eliminarLegislacaoPelaInterface(legislacaoId, legislacaoNome) {
    if (!legislacaoId) return;
    const confirmado = window.confirm(`Eliminar a legislação \"${legislacaoNome}\"?\nEsta ação não pode ser desfeita.`);
    if (!confirmado) return;
    const reason = window.prompt("Fundamentação obrigatória para eliminar esta legislação:");
    if (!reason || !reason.trim()) {
        if (importStatus) importStatus.textContent = "Eliminação cancelada: informe uma fundamentação.";
        return;
    }

    try {
        const response = await authenticatedFetch(`${API_URL}/legislacoes/${encodeURIComponent(legislacaoId)}`, {
            method: "DELETE",
            body: JSON.stringify({ reason: reason.trim() })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `Erro HTTP ${response.status}`);
        }
        if (importStatus) {
            importStatus.textContent = `Legislação eliminada: ${legislacaoNome} (${legislacaoId})`;
        }
        await carregarLegislacoes();
    } catch (error) {
        console.error("Erro ao eliminar legislação:", error);
        if (importStatus) {
            importStatus.textContent = `Falha ao eliminar: ${error.message}`;
        } else {
            alert(`Falha ao eliminar: ${error.message}`);
        }
    }
}

async function importarLegislacaoPelaInterface() {
    if (!uploadLegislacaoJson || !btnImportarLegislacao || !importStatus) return;

    const arquivo = uploadLegislacaoJson.files?.[0];
    if (!arquivo) {
        importStatus.textContent = "Selecione um arquivo .json antes de importar.";
        return;
    }

    btnImportarLegislacao.disabled = true;
    importStatus.textContent = "A importar legislação...";

    try {
        const texto = await arquivo.text();
        const payload = JSON.parse(texto);

        const response = await authenticatedFetch(`${API_URL}/legislacoes/importar`, {
            method: "POST",
            body: JSON.stringify(payload)
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `Erro HTTP ${response.status}`);
        }

        importStatus.textContent = `Importação concluída: ${data.legislacao?.nome || "Sem nome"} (${data.legislacao?.id || "sem id"})`;
        uploadLegislacaoJson.value = "";
        await carregarLegislacoes();
    } catch (error) {
        console.error("Erro ao importar legislação:", error);
        importStatus.textContent = `Falha na importação: ${error.message}`;
    } finally {
        btnImportarLegislacao.disabled = false;
    }
}

// =============================================
// INICIALIZAÇÃO
// =============================================

async function initLegislacao() {
    const menuButton = document.querySelector(".menu-button");
    const toolbarMenu = document.querySelector(".toolbar-menu");
    const heroCounterValue = document.getElementById("heroCounterValue");
    const heroCounterIncrement = document.getElementById("heroCounterIncrement");
    const heroCounterDecrement = document.getElementById("heroCounterDecrement");
    let heroCounter = 0;

    if (menuButton && toolbarMenu) {
        menuButton.addEventListener("click", () => {
            toolbarMenu.classList.toggle("active");
            menuButton.classList.toggle("active");
        });
    }

    if (heroCounterValue && heroCounterIncrement && heroCounterDecrement) {
        const updateHeroCounter = () => {
            heroCounterValue.textContent = String(heroCounter);
        };
        heroCounterIncrement.addEventListener("click", () => {
            heroCounter += 1;
            updateHeroCounter();
        });
        heroCounterDecrement.addEventListener("click", () => {
            heroCounter -= 1;
            updateHeroCounter();
        });
        updateHeroCounter();
    }

    legislacaoContainer = document.querySelector(".legislacao-container");
    searchInput = document.getElementById("searchInput");
    loadingAnimation = document.getElementById("loadingAnimation");
    uploadLegislacaoJson = document.getElementById("uploadLegislacaoJson");
    btnImportarLegislacao = document.getElementById("btnImportarLegislacao");
    importStatus = document.getElementById("importStatus");
    importadorLegislacao = document.getElementById("importadorLegislacao");

    if (!legislacaoContainer || !searchInput || !loadingAnimation) {
        console.error("⛔ Elementos essenciais não encontrados!");
        return;
    }

    // Configurar funcionalidades de UI
    persistSearch();
    setupQuickSearch();

    // Inicialmente, mostrar apenas o loading
    toggleLoading(true);
    toggleContent(false);

    // 🔑 Autenticação via authManager
    try {
        const user = await getUser();
        if (!user) {
            console.error("⛔ Usuário não autenticado. Redirecionando.");
            alert("Você precisa estar autenticado para acessar a legislação.");
            window.location.href = "/index.html";
            return;
        }

        const isAdmin = isAdminUser(user);
        userIsAdmin = isAdmin;
        if (importadorLegislacao) {
            importadorLegislacao.hidden = !isAdmin;
        }
        if (isAdmin && btnImportarLegislacao) {
            btnImportarLegislacao.addEventListener("click", importarLegislacaoPelaInterface);
        }

        console.log("✅ Usuário:", user.userId || user.uid);

        // Carregar legislações (sempre do servidor local)
        await carregarLegislacoes();
        
    } catch (error) {
        console.error("Erro durante inicialização:", error);
        toggleLoading(false);
        legislacaoContainer.innerHTML = "<p class='empty'>Erro ao carregar. Verifique se o servidor está rodando.</p>";
        toggleContent(true);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        initLegislacao().catch((error) => console.error("Erro ao inicializar legislação:", error));
    });
} else {
    initLegislacao().catch((error) => console.error("Erro ao inicializar legislação:", error));
}
