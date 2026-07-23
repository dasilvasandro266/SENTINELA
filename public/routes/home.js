// home.js - Lógica completa da página inicial
import { getUser, getUserData, authenticatedFetch, clearCache, isAdminUser } from "/authManager.js";
import Sidebar from "/components/Sidebar/Sidebar.js";
import Footer from "/components/Footer/Footer.js";
import ActiveDocumentsManager from '/active-documents/ActiveDocumentsManager.js';

// ============================================
// CONFIGURAÇÃO E CONSTANTES
// ============================================
const API_URL = '/api';

// Estado global da Sentinela
let conceitosById = {};
let aliasIndex = {};
let sentinelaCard = null;
let mouseSobreSpan = false;
let mouseSobreCard = false;
let cardTimeout = null;
let cardEmInteracao = false;

// Estado do usuário
let currentUser = null;
let currentUserData = null;
let gestoresCache = [];
let gestoresByNome = new Map();
let conteudosPorAutor = new Map();
let notificationStream = null;
let notificationStreamReconnectTimer = null;
let notificationStreamExpiresAt = 0;
let notificationPollTimer = null;

// Dados da formação
const niveis = [
    "1º ano",
    "2º ano",
    "3º ano",
    "4º ano",
    "5º ano"
];

const disciplinasPorNivel = {
    "1º ano": [
        "Introdução Ao Estudo Do Direito",
        "Direito Constitucional",
        "Economia Política",
        "História das Ideias Políticas e Jurídicas",
        "Direito Romano"
    ],
    "2º ano": [
        "Teoria Geral do Direito Civil",
        "Finanças Públicas e Direito Financeiro",
        "Direito Internacional Público",
        "Direito Administrativo"
    ],
    "3º ano": [
        "Direito Processual Civil",
        "Direito do Urbanismo e do Ambiente",
        "Direito Penal",
        "Direito das Obrigações",
        "Direito Do Trabalho",
        "Direito Eclesiástico"
    ],
    "4º ano": [
        "Direito Processual Penal",
        "Direito Comercial",
        "Direito do Trabalho",
        "Direito Fiscal"
    ],
    "5º ano": [
        "Prática Jurídica",
        "Ética Profissional",
        "Direito da Segurança Social",
        "Direito Internacional Privado"
    ]
};

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================
function normalizarTexto(texto) {
    return texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(texto = "") {
    return String(texto)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizarNomeAutor(nome) {
    return normalizarTexto(nome || "");
}

function formatarDataCurta(valor) {
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) {
        return "";
    }
    return data.toLocaleDateString("pt-PT", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function encerrarFluxoNotificacoes() {
    if (notificationStream) {
        notificationStream.close();
        notificationStream = null;
    }
    if (notificationStreamReconnectTimer) {
        clearTimeout(notificationStreamReconnectTimer);
        notificationStreamReconnectTimer = null;
    }
    if (notificationPollTimer) {
        clearInterval(notificationPollTimer);
        notificationPollTimer = null;
    }
    notificationStreamExpiresAt = 0;
}

function agendarReconexaoFluxoNotificacoes(delayMs = 10000) {
    if (notificationStreamReconnectTimer) return;
    notificationStreamReconnectTimer = setTimeout(() => {
        notificationStreamReconnectTimer = null;
        iniciarFluxoNotificacoes().catch((error) => {
            console.error("Erro ao reconectar fluxo de notificações:", error);
            agendarReconexaoFluxoNotificacoes(Math.min(delayMs * 1.5, 30000));
        });
    }, delayMs);
}

async function obterTokenFluxoNotificacoes() {
    const response = await authenticatedFetch(`${API_URL}/notificacoes/stream-token`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Falha ao criar stream de notificações (${response.status})`);
    }

    const data = await response.json();
    if (!data?.token) {
        throw new Error("Token de stream ausente");
    }

    notificationStreamExpiresAt = Number(data.expiresAt) || 0;
    return data.token;
}

function iniciarPollingNotificacoes(intervalMs = 15000) {
    if (notificationPollTimer) return;
    const atualizar = () => {
        carregarNotificacoes().catch((error) => {
            console.warn("Falha ao atualizar notificações por polling:", error);
        });
    };

    notificationPollTimer = setInterval(atualizar, intervalMs);
    atualizar();
}

async function iniciarFluxoNotificacoes() {
    if (!currentUser) return;
    if (notificationStream && notificationStream.readyState === EventSource.OPEN) return;

    if (notificationStream) {
        notificationStream.close();
        notificationStream = null;
    }

    try {
        const token = await obterTokenFluxoNotificacoes();
        if (!token) {
            iniciarPollingNotificacoes();
            return;
        }
        const source = new EventSource(`${API_URL}/notificacoes/stream`);
        notificationStream = source;
        if (notificationStreamReconnectTimer) {
            clearTimeout(notificationStreamReconnectTimer);
            notificationStreamReconnectTimer = null;
        }

        const refrescar = () => {
            carregarNotificacoes();
        };

        source.addEventListener("connected", refrescar);
        source.addEventListener("notification", (event) => {
            if (event?.data) {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload?.type === "refresh" || payload?.type === "connected") {
                        carregarNotificacoes();
                    }
                } catch {
                    carregarNotificacoes();
                }
                return;
            }
            carregarNotificacoes();
        });
        source.addEventListener("message", refrescar);

        source.onerror = () => {
            if (!notificationStream) return;
            if (notificationStream.readyState === EventSource.CLOSED) {
                encerrarFluxoNotificacoes();
                iniciarPollingNotificacoes();
            }
        };
    } catch (error) {
        console.error("Erro ao iniciar fluxo de notificações:", error);
        encerrarFluxoNotificacoes();
        iniciarPollingNotificacoes();
    }
}

// ============================================
// HIROMI (CHAT JURÍDICO)
// ============================================
const HIROMI_MAX_PERGUNTA = 600;
const HIROMI_CHAT_STORAGE_PREFIX = "sentinela_hiromi_chats_v1";
const HIROMI_MAX_CHATS = 12;
const HIROMI_MAX_MESSAGES_PER_CHAT = 120;

function gerarIdHiromi() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatarHoraMensagem(ts) {
    const data = Number.isFinite(ts) ? new Date(ts) : new Date();
    return data.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

function gerarTituloChat(texto = "") {
    const limpo = String(texto || "").replace(/\s+/g, " ").trim();
    if (!limpo) return "Novo chat";
    return limpo.length > 44 ? `${limpo.slice(0, 44)}...` : limpo;
}

function diasDesde(ts) {
    const oneDay = 24 * 60 * 60 * 1000;
    const diff = Date.now() - (Number(ts) || Date.now());
    return Math.max(0, Math.floor(diff / oneDay));
}

function criarElementoMensagem(role, texto, fontes = [], timestamp = Date.now()) {
    const item = document.createElement("div");
    item.className = `hiromi-message ${role}`;

    const textoEl = document.createElement("div");
    textoEl.className = "hiromi-text";
    textoEl.textContent = texto;
    item.appendChild(textoEl);

    if (Array.isArray(fontes) && fontes.length > 0) {
        const fontesEl = document.createElement("div");
        fontesEl.className = "hiromi-sources";
        fontes.forEach((fonte) => {
            const linha = document.createElement("div");
            const label = fonte?.display
                ? fonte.display
                : `[${fonte?.tipo || "conteudo"}] ${fonte?.titulo || "Fonte"}`;

            if (fonte?.link) {
                const link = document.createElement("a");
                link.href = fonte.link;
                link.textContent = label;
                link.target = "_blank";
                link.rel = "noopener";
                linha.appendChild(link);
            } else {
                linha.textContent = label;
            }

            fontesEl.appendChild(linha);
        });
        item.appendChild(fontesEl);
    }

    const meta = document.createElement("div");
    meta.className = "hiromi-meta";
    meta.textContent = formatarHoraMensagem(timestamp);
    item.appendChild(meta);

    return item;
}

function initHiromi() {
    const toggle = document.getElementById("hiromiToggle");
    const widget = document.querySelector(".hiromi-widget");
    const panel = document.getElementById("hiromiPanel");
    const closeBtn = document.getElementById("hiromiClose");
    const greeting = document.getElementById("hiromiGreeting");
    const form = document.getElementById("hiromiForm");
    const input = document.getElementById("hiromiQuestion");
    const messages = document.getElementById("hiromiMessages");
    const sendBtn = document.getElementById("hiromiSend");
    const chatList = document.getElementById("hiromiChatList");
    const hiromiMain = document.querySelector(".hiromi-main");
    const newChatBtn = document.getElementById("hiromiNewChat");
    const clearDraftBtn = document.getElementById("hiromiClearDraft");

    if (!toggle || !panel || !form || !input || !messages || !sendBtn) return;
    if (!isAdminUser(currentUser)) {
        widget?.setAttribute("hidden", "");
        panel.classList.remove("is-open");
        panel.setAttribute("aria-hidden", "true");
        toggle.setAttribute("aria-expanded", "false");
        document.body.classList.remove("hiromi-open");
        return;
    }

    widget?.removeAttribute("hidden");

    const storageKey = `${HIROMI_CHAT_STORAGE_PREFIX}:${currentUser?.id || "anon"}`;
    let hiromiState = { activeChatId: null, chats: [] };

    const criarChat = () => ({
        id: gerarIdHiromi(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title: "",
        messages: []
    });

    const salvarEstado = () => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(hiromiState));
        } catch (error) {
            console.warn("Falha ao guardar chats da Hiromi:", error);
        }
    };

    const carregarEstado = () => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.chats)) return;
            hiromiState = {
                activeChatId: parsed.activeChatId || null,
                chats: parsed.chats
                    .filter((chat) => chat && chat.id)
                    .map((chat) => ({
                        id: chat.id,
                        createdAt: Number(chat.createdAt) || Date.now(),
                        updatedAt: Number(chat.updatedAt) || Date.now(),
                        title: String(chat.title || "").trim(),
                        messages: Array.isArray(chat.messages)
                            ? chat.messages
                                .filter((m) => m && m.role && typeof m.text === "string")
                                .map((m) => ({
                                    role: m.role === "user" ? "user" : "bot",
                                    text: m.text,
                                    sources: Array.isArray(m.sources) ? m.sources : [],
                                    timestamp: Number(m.timestamp) || Date.now()
                                }))
                            : []
                    }))
                    .slice(0, HIROMI_MAX_CHATS)
            };
        } catch (error) {
            console.warn("Falha ao carregar chats da Hiromi:", error);
        }
    };

    const garantirChatActivo = () => {
        if (!hiromiState.chats.length) {
            const novo = criarChat();
            hiromiState.chats = [novo];
            hiromiState.activeChatId = novo.id;
            salvarEstado();
            return;
        }
        const existe = hiromiState.chats.some((c) => c.id === hiromiState.activeChatId);
        if (!existe) {
            hiromiState.activeChatId = hiromiState.chats[0].id;
            salvarEstado();
        }
    };

    const obterChatActivo = () => {
        garantirChatActivo();
        return hiromiState.chats.find((c) => c.id === hiromiState.activeChatId) || hiromiState.chats[0];
    };

    const nomeUsuario = String(
        currentUserData?.nome ||
        currentUser?.nome ||
        currentUser?.name ||
        ""
    ).trim().split(/\s+/)[0];

    if (greeting) {
        const hora = new Date().getHours();
        const saudacaoBase = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
        greeting.textContent = nomeUsuario ? `${saudacaoBase}, ${nomeUsuario}.` : `${saudacaoBase}.`;
    }

    const refreshMessagesState = (hasMessages = messages.children.length > 0) => {
        messages.classList.toggle("is-empty", !hasMessages);
        if (hiromiMain) hiromiMain.classList.toggle("has-chat", hasMessages);
    };

    const scrollMensagensParaFim = () => {
        requestAnimationFrame(() => {
            messages.scrollTop = messages.scrollHeight;
            requestAnimationFrame(() => {
                messages.scrollTop = messages.scrollHeight;
            });
        });
    };

    const renderizarListaChats = () => {
        if (!chatList) return;
        chatList.innerHTML = "";
        const chatsComMensagens = hiromiState.chats.filter((chat) => Array.isArray(chat.messages) && chat.messages.length > 0);
        if (!chatsComMensagens.length) {
            return;
        }

        const grupos = [
            { titulo: "Today", filtro: (chat) => diasDesde(chat.updatedAt) === 0 },
            { titulo: "7 Days", filtro: (chat) => diasDesde(chat.updatedAt) > 0 && diasDesde(chat.updatedAt) <= 7 },
            { titulo: "30 Days", filtro: (chat) => diasDesde(chat.updatedAt) > 7 && diasDesde(chat.updatedAt) <= 30 },
            { titulo: "Older", filtro: (chat) => diasDesde(chat.updatedAt) > 30 }
        ];

        grupos.forEach((grupo) => {
            const subset = chatsComMensagens.filter(grupo.filtro);
            if (!subset.length) return;
            const wrapper = document.createElement("div");
            wrapper.className = "hiromi-chat-group";

            const h = document.createElement("div");
            h.className = "hiromi-chat-group-title";
            h.textContent = grupo.titulo;
            wrapper.appendChild(h);

            subset
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .forEach((chat) => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = `hiromi-chat-item ${chat.id === hiromiState.activeChatId ? "is-active" : ""}`;
                    btn.textContent = chat.title || "Novo chat";
                    btn.addEventListener("click", () => {
                        hiromiState.activeChatId = chat.id;
                        salvarEstado();
                        renderizarListaChats();
                        renderizarChatActivo();
                        input.focus();
                    });
                    wrapper.appendChild(btn);
                });

            chatList.appendChild(wrapper);
        });
    };

    const renderizarChatActivo = () => {
        const chat = obterChatActivo();
        messages.innerHTML = "";
        chat.messages.forEach((msg) => {
            messages.appendChild(criarElementoMensagem(msg.role, msg.text, msg.sources, msg.timestamp));
        });
        refreshMessagesState(chat.messages.length > 0);
        scrollMensagensParaFim();
    };

    const adicionarMensagemNoChat = (role, text, sources = []) => {
        const chat = obterChatActivo();
        const nova = {
            role: role === "user" ? "user" : "bot",
            text: String(text || ""),
            sources: Array.isArray(sources) ? sources : [],
            timestamp: Date.now()
        };
        chat.messages.push(nova);
        if (!chat.title && nova.role === "user") {
            chat.title = gerarTituloChat(nova.text);
        }
        if (chat.messages.length > HIROMI_MAX_MESSAGES_PER_CHAT) {
            chat.messages = chat.messages.slice(-HIROMI_MAX_MESSAGES_PER_CHAT);
        }
        chat.updatedAt = Date.now();
        hiromiState.chats = hiromiState.chats
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, HIROMI_MAX_CHATS);
        salvarEstado();
        messages.appendChild(criarElementoMensagem(nova.role, nova.text, nova.sources, nova.timestamp));
        refreshMessagesState(true);
        renderizarListaChats();
        scrollMensagensParaFim();
    };

    const criarNovoChat = () => {
        const novo = criarChat();
        hiromiState.chats.unshift(novo);
        hiromiState.chats = hiromiState.chats.slice(0, HIROMI_MAX_CHATS);
        hiromiState.activeChatId = novo.id;
        salvarEstado();
        renderizarListaChats();
        renderizarChatActivo();
        input.value = "";
        input.focus();
    };

    const setOpen = (open) => {
        panel.classList.toggle("is-open", open);
        panel.setAttribute("aria-hidden", String(!open));
        toggle.setAttribute("aria-expanded", String(open));
        if (widget) widget.classList.toggle("is-open", open);
        document.body.classList.toggle("hiromi-open", open);
        toggle.style.visibility = open ? "hidden" : "visible";
        toggle.style.pointerEvents = open ? "none" : "auto";
        if (open) {
            renderizarListaChats();
            renderizarChatActivo();
            setTimeout(() => input.focus(), 50);
        }
    };

    toggle.addEventListener("click", () => {
        const isOpen = panel.classList.contains("is-open");
        setOpen(!isOpen);
    });

    closeBtn?.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && panel.classList.contains("is-open")) {
            setOpen(false);
        }
    });

    newChatBtn?.addEventListener("click", () => criarNovoChat());
    clearDraftBtn?.addEventListener("click", () => {
        input.value = "";
        input.focus();
    });

    carregarEstado();
    garantirChatActivo();
    renderizarListaChats();
    renderizarChatActivo();

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const pergunta = String(input.value || "").trim();
        if (!pergunta) return;
        if (pergunta.length > HIROMI_MAX_PERGUNTA) {
            adicionarMensagemNoChat("bot", "A tua pergunta é muito longa. Resume para até 600 caracteres.");
            return;
        }

        adicionarMensagemNoChat("user", pergunta);

        input.value = "";
        input.disabled = true;
        sendBtn.disabled = true;

        const typing = criarElementoMensagem("bot", "A pesquisar no conteúdo da plataforma...");
        messages.appendChild(typing);
        scrollMensagensParaFim();

        try {
            const chat = obterChatActivo();
            const history = chat.messages.slice(-8).map((m) => ({ role: m.role, text: m.text }));
            const response = await authenticatedFetch(`${API_URL}/hiromi/ask`, {
                method: "POST",
                body: JSON.stringify({ question: pergunta, history })
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                if (response.status === 429) {
                    throw new Error(data?.error || "A Hiromi está recebendo muitas perguntas. Aguarde alguns segundos.");
                }
                throw new Error(data?.error || "Erro ao obter resposta da Hiromi.");
            }

            const data = await response.json();
            const resposta = data?.answer || "Encontrei conteúdo relevante, mas não consegui gerar uma resposta.";
            const fontes = Array.isArray(data?.sources) ? data.sources : [];

            typing.remove();
            adicionarMensagemNoChat("bot", resposta, fontes);
        } catch (error) {
            typing.remove();
            const rawMsg = String(error?.message || '');
            const networkLike = /failed to fetch|networkerror|network error/i.test(rawMsg);
            const finalMsg = networkLike
                ? "Falha de ligação com a Hiromi. Verifique a conexão e confirme se o servidor da plataforma está ativo."
                : (rawMsg || "Erro ao falar com a Hiromi.");
            adicionarMensagemNoChat("bot", finalMsg);
        } finally {
            input.disabled = false;
            sendBtn.disabled = false;
            input.focus();
        }
    });
}

async function carregarGestoresEquipe() {
    try {
        const response = await fetch('/gestores.json', { cache: 'no-cache' });
        if (!response.ok) return;
        const data = await response.json();
        gestoresCache = Array.isArray(data) ? data.filter(Boolean) : Object.values(data || {});
        gestoresByNome = new Map(
            gestoresCache
                .filter((g) => g?.nome)
                .map((g) => [normalizarNomeAutor(g.nome), g])
        );
    } catch (error) {
        console.warn('Falha ao carregar gestores:', error);
    }
}

async function carregarConteudosAutores() {
    if (!currentUser) return;
    try {
        const response = await authenticatedFetch(`${API_URL}/home/conteudos-autores`);
        if (!response.ok) return;
        const data = await response.json();
        conteudosPorAutor = new Map();
        (data.items || []).forEach((item) => {
            const autores = Array.isArray(item.autores) ? item.autores : [];
            autores.forEach((autor) => {
                const key = normalizarNomeAutor(autor);
                if (!key) return;
                const lista = conteudosPorAutor.get(key) || [];
                lista.push(item);
                conteudosPorAutor.set(key, lista);
            });
        });
    } catch (error) {
        console.warn('Falha ao carregar conteúdos por autor:', error);
    }
}

function criarModalAutor() {
    if (document.getElementById('autorModal')) return;
    const modal = document.createElement('div');
    modal.id = 'autorModal';
    modal.className = 'autor-modal hidden';
    modal.innerHTML = `
        <div class="autor-modal-content" role="dialog" aria-modal="true" aria-labelledby="autorModalTitulo">
            <button class="autor-fechar" type="button" aria-label="Fechar">&times;</button>
            <div class="autor-header">
                <img class="autor-foto" alt="" />
                <div>
                    <h3 id="autorModalTitulo" class="autor-nome"></h3>
                    <p class="autor-desc"></p>
                </div>
            </div>
            <div class="autor-textos">
                <h4>Textos publicados</h4>
                <ul class="autor-textos-list"></ul>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.classList.contains('autor-fechar')) {
            modal.classList.add('hidden');
        }
    });
}

function abrirModalAutor(nomeAutor) {
    if (!nomeAutor) return;
    criarModalAutor();
    const modal = document.getElementById('autorModal');
    if (!modal) return;

    const gestor = gestoresByNome.get(normalizarNomeAutor(nomeAutor)) || { nome: nomeAutor, descricao: '' };
    const foto = modal.querySelector('.autor-foto');
    const nomeEl = modal.querySelector('.autor-nome');
    const descEl = modal.querySelector('.autor-desc');
    const listaEl = modal.querySelector('.autor-textos-list');

    if (foto) {
        foto.src = gestor.imagem || '/images/virtruviano2.png';
        foto.alt = gestor.nome ? `Foto de ${gestor.nome}` : 'Foto do autor';
        foto.onerror = function() {
            this.src = '/images/virtruviano2.png';
        };
    }
    if (nomeEl) nomeEl.textContent = gestor.nome || nomeAutor;
    if (descEl) descEl.textContent = gestor.descricao || '';

    if (listaEl) {
        listaEl.innerHTML = '';
        const textos = conteudosPorAutor.get(normalizarNomeAutor(nomeAutor)) || [];
        if (!textos.length) {
            const empty = document.createElement('li');
            empty.textContent = 'Sem textos publicados ainda.';
            listaEl.appendChild(empty);
        } else {
            textos.forEach((item) => {
                const li = document.createElement('li');
                const titulo = `${item.tema} • ${item.fase}`;
                li.innerHTML = `<button type="button" class="autor-texto-link">${escapeHtml(titulo)}</button><span class="autor-texto-disc">${escapeHtml(item.disciplina || '')}</span>`;
                li.querySelector('button')?.addEventListener('click', () => {
                    abrirConteudoFase({
                        disciplina: item.disciplina,
                        nome: item.tema,
                        subtema: item.fase,
                        tema: item.tema,
                        fase: item.fase,
                    });
                });
                listaEl.appendChild(li);
            });
        }
    }

    modal.classList.remove('hidden');
}

// ============================================
// NOTIFICAÇÕES
// ============================================
function criarSistemaNotificacoes() {
    let notificationIcon = document.querySelector(".notification-icon");
    if (notificationIcon && notificationIcon.dataset.notificationsReady === "1") {
        return;
    }
    if (!notificationIcon) {
        notificationIcon = document.createElement("div");
        notificationIcon.classList.add("notification-icon");
        document.body.appendChild(notificationIcon);
    }

    notificationIcon.setAttribute("role", "button");
    notificationIcon.setAttribute("tabindex", "0");
    notificationIcon.setAttribute("aria-label", "Abrir notificações");
    notificationIcon.innerHTML = `
        <span class="notification-bell" aria-hidden="true">
            <i class="fas fa-bell"></i>
            <span class="notification-bell-pulse"></span>
        </span>
        <span class="notification-count" aria-label="Notificações não lidas" style="display:none;">0</span>
    `;

    let notificationPanel = document.querySelector(".notification-panel");
    if (!notificationPanel) {
        notificationPanel = document.createElement("div");
        notificationPanel.classList.add("notification-panel");
    }

    const notificationHeader = document.createElement("div");
    notificationHeader.classList.add("notification-header");
    notificationHeader.innerHTML = `
        <div class="notification-header-copy">
            <h2>Notificações</h2>
            <p>Alertas, avisos e atualizações recentes</p>
        </div>
        <div class="notification-actions">
            <button class="limpar-notificacoes" title="Apagar notificações vistas" aria-label="Apagar notificações vistas">
                <i class="fa-solid fa-broom"></i>
                <span>Vistas</span>
            </button>
            <button class="fechar-notificacoes" title="Fechar painel" aria-label="Fechar painel">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `;

    let notificationList = document.getElementById("notification-list");
    if (!notificationList) {
        notificationList = document.createElement("ul");
        notificationList.id = "notification-list";
    }

    notificationPanel.innerHTML = "";
    notificationPanel.append(notificationHeader, notificationList);
    if (!notificationPanel.parentElement) {
        document.body.appendChild(notificationPanel);
    }

    notificationIcon.addEventListener("click", () => {
        notificationPanel.classList.toggle("active");
    });

    notificationIcon.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            notificationPanel.classList.toggle("active");
        }
    });

    notificationIcon.dataset.notificationsReady = "1";

    notificationPanel.addEventListener("click", (event) => {
        if (event.target.classList.contains("fechar-notificacoes")) {
            notificationPanel.classList.remove("active");
        }
        if (event.target.classList.contains("limpar-notificacoes")) {
            apagarNotificacoesVistas();
        }
    });

    document.addEventListener("click", (event) => {
        if (!notificationPanel.classList.contains("active")) return;

        const isInside = notificationPanel.contains(event.target);
        const isIcon = notificationIcon.contains(event.target);

        if (!isInside && !isIcon) {
            notificationPanel.classList.remove("active");
        }
    });
}

async function carregarNotificacoes() {
    if (!currentUser) return;

    try {
        const response = await authenticatedFetch(`${API_URL}/notificacoes`);
        if (response.ok) {
            const notificacoes = await response.json();
            atualizarListaNotificacoes(notificacoes);
            atualizarContadorNotificacoes(notificacoes);
        }
    } catch (error) {
        console.error("Erro ao carregar notificações:", error);
    }
}

async function marcarNotificacaoLida(notificacaoId) {
    try {
        await authenticatedFetch(`${API_URL}/notificacoes/marcar-lida/${notificacaoId}`, {
            method: 'POST'
        });
        carregarNotificacoes();
    } catch (error) {
        console.error("Erro ao marcar notificação:", error);
    }
}

async function apagarNotificacoesVistas() {
    try {
        await authenticatedFetch(`${API_URL}/notificacoes/apagar-vistas`, {
            method: 'POST'
        });
        carregarNotificacoes();
    } catch (error) {
        console.error("Erro ao apagar notificações vistas:", error);
    }
}

function atualizarListaNotificacoes(notificacoes) {
    const notificationList = document.getElementById("notification-list");
    if (!notificationList) return;

    notificationList.innerHTML = "";

    if (!Array.isArray(notificacoes) || notificacoes.length === 0) {
        notificationList.innerHTML = '<li class="notification-empty">Sem notificações por agora.</li>';
        atualizarBotaoLimparNotificacoes([]);
        return;
    }

    notificacoes
        .sort((a, b) => new Date(b.data) - new Date(a.data))
        .forEach(notif => {
            const li = document.createElement("li");
            const mensagem = notif.mensagem ? `<div class="notification-message">${escapeHtml(notif.mensagem)}</div>` : "";
            const dataFormatada = formatarDataCurta(notif.data) || new Date(notif.data).toLocaleDateString();
            const estado = notif.lida ? "Lida" : "Nova";
            li.innerHTML = `
                <div class="notification-item-shell">
                    <div class="notification-item-top">
                        <strong>${escapeHtml(notif.titulo)}</strong>
                        <span class="notification-state">${estado}</span>
                    </div>
                    ${mensagem}
                    <div class="notification-item-meta">
                        <span>${escapeHtml(dataFormatada)}</span>
                        <span>Toque para abrir</span>
                    </div>
                </div>
            `;
            if (!notif.lida) li.classList.add("nao-lida");

            li.addEventListener("click", () => {
                const payload = extrairPayloadNotificacao(notif);
                if (payload) {
                    abrirConteudoFase(payload);
                    const panel = document.querySelector(".notification-panel");
                    if (panel) panel.classList.remove("active");
                }
                if (!notif.lida && notif.id) {
                    marcarNotificacaoLida(notif.id);
                }
            });

            notificationList.appendChild(li);
        });

    atualizarBotaoLimparNotificacoes(notificacoes);
}

function extrairPayloadNotificacao(notif) {
    const titulo = String(notif.titulo || "").trim();
    const mensagem = String(notif.mensagem || "").trim();
    if (!titulo.startsWith("Novo conteúdo em ")) return null;
    const disciplina = titulo.replace("Novo conteúdo em ", "").trim();
    if (!disciplina) return null;

    const parts = mensagem.split("•").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const nome = parts[0];
    const subtema = parts.slice(1).join(" • ");
    if (!nome || !subtema) return null;

    return {
        disciplina,
        nome,
        subtema,
        tema: nome,
        fase: subtema,
    };
}

function atualizarContadorNotificacoes(notificacoes) {
    const contador = document.querySelector(".notification-count");
    const notificationIcon = document.querySelector(".notification-icon");
    if (!contador) return;

    const naoLidas = notificacoes.filter(n => !n.lida).length;
    contador.textContent = naoLidas;
    contador.style.display = naoLidas > 0 ? "inline" : "none";
    notificationIcon?.classList.toggle("has-unread", naoLidas > 0);
}

function atualizarBotaoLimparNotificacoes(notificacoes) {
    const botao = document.querySelector(".limpar-notificacoes");
    if (!botao) return;
    const hasVistas = notificacoes.some((n) => n.lida);
    botao.disabled = !hasVistas;
    botao.classList.toggle("disabled", !hasVistas);
}

// ============================================
// FORMAÇÃO JURÍDICA
// ============================================
function renderNiveis() {
    const container = document.getElementById("niveis-container");
    if (!container) return;

    container.innerHTML = "";

    const ativarInteracaoHolografica = (card) => {
        const reset = () => {
            card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg)";
            card.style.setProperty("--x", "50%");
            card.style.setProperty("--y", "50%");
            card.style.setProperty("--bg-x", "50%");
            card.style.setProperty("--bg-y", "50%");
        };

        card.addEventListener("mousemove", (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = (y - centerY) / 11;
            const rotateY = (centerX - x) / 11;

            card.style.setProperty("--x", `${x}px`);
            card.style.setProperty("--y", `${y}px`);
            card.style.setProperty("--bg-x", `${(x / rect.width) * 100}%`);
            card.style.setProperty("--bg-y", `${(y / rect.height) * 100}%`);
            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
        });

        card.addEventListener("mouseleave", reset);
        reset();
    };

    niveis.forEach((nivel, index) => {
        const card = document.createElement("div");
        card.classList.add("nivel-card");
    card.dataset.summaryId = `home-summary-${index}`;
        const titulo = document.createElement("h3");
        titulo.textContent = nivel;
        card.appendChild(titulo);

        const meta = document.createElement("p");
        meta.classList.add("nivel-meta");
        card.appendChild(meta);

        // Todos os níveis ficam disponíveis, sem trava
        const btn = document.createElement("button");
        btn.textContent = "Ver Etapas";
        btn.classList.add("btn-ver-etapas");
        btn.dataset.summaryAction = "show";
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            abrirModalEtapas(nivel);
        });
        card.appendChild(btn);

        const glow = document.createElement("div");
        glow.classList.add("nivel-holo-glow");
        card.appendChild(glow);

        ativarInteracaoHolografica(card);
        container.appendChild(card);
    });
}

function inicializarCarrosseis() {
    const botoes = document.querySelectorAll("[data-carousel-btn]");
    botoes.forEach((botao) => {
        botao.addEventListener("click", () => {
            const direcao = botao.dataset.carouselBtn;
            const alvoId = botao.dataset.carouselTarget;
            const track = alvoId ? document.getElementById(alvoId) : null;
            if (!track) return;

            const primeiroCard = track.children[0];
            if (!primeiroCard) return;

            const gap = parseFloat(window.getComputedStyle(track).gap || "0");
            const passo = primeiroCard.getBoundingClientRect().width + gap;
            const offset = direcao === "prev" ? -passo : passo;
            track.scrollBy({ left: offset, behavior: "smooth" });
        });
    });
}

function abrirModalEtapas(nivel) {
    const disciplinas = disciplinasPorNivel[nivel] || [];
    const container = document.getElementById("listaEtapas");
    const titulo = document.getElementById("etapasModalTitle");

    if (!container || !titulo) return;

    titulo.textContent = `Etapas do ${nivel}`;
    container.innerHTML = '';

    disciplinas.forEach((disciplina, index) => {
        const div = document.createElement("div");
        div.textContent = `${index + 1}. ${disciplina}`;
        div.style.padding = "10px";
        div.style.borderBottom = "1px solid var(--p2)";
        div.style.cursor = "pointer";
        div.addEventListener("click", (e) => {
            e.stopPropagation();
            fecharModalEtapas();
            abrirMapaSVG(disciplina);
        });
        container.appendChild(div);
    });

    const modal = document.getElementById("etapasModal");
    modal.classList.add("show");
}

function fecharModalEtapas() {
    const modal = document.getElementById("etapasModal");
    if (modal) modal.classList.remove("show");
}

// ============================================
// DASHBOARD
// ============================================
async function carregarDashboard(userId) {
    // Últimas legislações
    try {
        const response = await authenticatedFetch(`${API_URL}/historico/legislacoes/${userId}`);
        if (response.ok) {
            const legislacoes = await response.json();
            const ul = document.querySelector('#ultimas-legislacoes ul');
            if (!ul) return;
            ul.innerHTML = '';
            
            if (legislacoes.length > 0) {
                legislacoes.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = `<a href="leitor.html?legislacao=${encodeURIComponent(item.legislacao_id)}" target="_blank">${item.titulo}</a>`;
                    ul.appendChild(li);
                });
            } else {
                ul.innerHTML = '<li>Nenhuma legislação visitada recentemente.</li>';
            }
        }
    } catch (error) {
        console.error("Erro ao carregar legislações:", error);
    }

    // Remissões recentes
    try {
        const response = await authenticatedFetch(`${API_URL}/remissoes/${userId}`);
        if (response.ok) {
            const remissoes = await response.json();
            const ul = document.querySelector('#lista-remissoes');
            if (!ul) return;
            ul.innerHTML = '';
            ul.style.display = 'flex';
            
            if (remissoes.length > 0) {
                remissoes.forEach(rem => {
                    const li = document.createElement('li');
                    li.style.marginRight = '15px';
                    li.style.padding = '8px';
                    li.style.border = '1px solid #ccc';
                    li.style.borderRadius = '8px';
                    li.style.backgroundColor = '#f9f9f9';
                    li.style.minWidth = '180px';

                    const origemNome = rem.lei_origem || rem.legislacao_origem_id || 'Lei';
                    const destinoNome = rem.lei_destino || rem.legislacao_destino_id || '?';

                    li.innerHTML = `
                        <div><strong>${origemNome}</strong></div>
                        <div>Art. ${rem.artigo_origem || '?'} → ${destinoNome}, Art. ${rem.artigo_destino || '?'}</div>
                        <div style="font-size: 0.8em; color: gray;">${new Date(rem.timestamp).toLocaleDateString()}</div>
                    `;
                    ul.appendChild(li);
                });
            } else {
                ul.innerHTML = '<li>Sem remissões recentes.</li>';
            }
        }
    } catch (error) {
        console.error("Erro ao carregar remissões:", error);
    }

    // Jurisprudência via PostgreSQL
    try {
        const response = await authenticatedFetch(`${API_URL}/home/dashboard-content`);
        const ulJurisprudencia = document.querySelector('#jurisprudencia-recente ul');

        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await response.json();

        if (ulJurisprudencia) {
            const itens = Array.isArray(data.jurisprudencias) ? data.jurisprudencias : [];
            ulJurisprudencia.innerHTML = '';

            if (itens.length) {
                itens.forEach((item) => {
                    const li = document.createElement("li");
                    const link = document.createElement("a");
                    link.href = item.link || `/app/reader?jurisprudencia=${encodeURIComponent(item.id || "")}`;
                    link.textContent = item.titulo || "Jurisprudência";
                    li.appendChild(link);

                    if (item.subtitulo) {
                        const meta = document.createElement("span");
                        meta.className = "dashboard-jurisprudencia-meta";
                        meta.textContent = item.subtitulo;
                        li.appendChild(meta);
                    }

                    if (item.updated_at) {
                        const stamp = document.createElement("small");
                        stamp.className = "dashboard-jurisprudencia-stamp";
                        stamp.textContent = `Atualizado ${formatarDataCurta(item.updated_at)}`;
                        li.appendChild(stamp);
                    }

                    ulJurisprudencia.appendChild(li);
                });
            } else {
                ulJurisprudencia.innerHTML = '<li>Sem jurisprudência recente no banco.</li>';
            }
        }
    } catch (error) {
        console.error("Erro ao carregar conteúdo de dashboard da Home:", error);
    }
}

// ============================================
// MAPA SVG
// ============================================
async function abrirMapaSVG(disciplina) {
    const svg       = document.getElementById("svgMapa");
    const container = document.getElementById("svgMapaContainer");
    const titulo    = document.getElementById("svgMapaTitulo");

    if (!svg || !container || !titulo) return;

    titulo.textContent = `📘 ${disciplina} – Mapa Interativo`;

    // Limpar conteúdo e controlos anteriores
    svg.innerHTML = "";
    container.querySelectorAll(".mapa-ctrl-btn").forEach(b => b.remove());

    // ── Defs: sombra suave + glow para nós activos ─────────────────────────
    const NS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(NS, "defs");

    const makeShadow = (id, dy, blur, opacity) => {
        const filter = document.createElementNS(NS, "filter");
        filter.setAttribute("id", id);
        filter.setAttribute("x", "-25%"); filter.setAttribute("y", "-25%");
        filter.setAttribute("width", "150%"); filter.setAttribute("height", "150%");
        const fe = document.createElementNS(NS, "feDropShadow");
        fe.setAttribute("dx", "0"); fe.setAttribute("dy", String(dy));
        fe.setAttribute("stdDeviation", String(blur));
        fe.setAttribute("flood-opacity", String(opacity));
        filter.appendChild(fe);
        return filter;
    };
    defs.appendChild(makeShadow("shadowTema", 3, 4, 0.30));
    defs.appendChild(makeShadow("shadowFase", 2, 3, 0.25));

    // Glow para hover dos nós de fase
    const glowFilter = document.createElementNS(NS, "filter");
    glowFilter.setAttribute("id", "glowFase");
    glowFilter.setAttribute("x", "-30%"); glowFilter.setAttribute("y", "-30%");
    glowFilter.setAttribute("width", "160%"); glowFilter.setAttribute("height", "160%");
    const feGlow = document.createElementNS(NS, "feDropShadow");
    feGlow.setAttribute("dx", "0"); feGlow.setAttribute("dy", "0");
    feGlow.setAttribute("stdDeviation", "5");
    feGlow.setAttribute("flood-color", "#D2B48C");
    feGlow.setAttribute("flood-opacity", "0.7");
    glowFilter.appendChild(feGlow);
    defs.appendChild(glowFilter);

    svg.appendChild(defs);

    const svgContent = document.createElementNS(NS, "g");
    svgContent.id = "svgContent";
    svg.appendChild(svgContent);

    // ── Dados ──────────────────────────────────────────────────────────────
    const response = await fetch("/dadosDisciplinas.json");
    const dadosDisciplinas = await response.json();
    const temas = dadosDisciplinas[disciplina] || [];

    if (temas.length === 0) {
        console.warn(`Nenhum tema encontrado para a disciplina: ${disciplina}`);
        return;
    }

    // ── Paleta ─────────────────────────────────────────────────────────────
    const rs  = getComputedStyle(document.documentElement);
    const get = (v, fb) => rs.getPropertyValue(v).trim() || fb;
    const p1  = get('--p1',  '#F5F0E6');
    const p6  = get('--p6',  '#D2B48C');
    const p7  = get('--p7',  '#C4A27A');
    const p8  = get('--p8',  '#B69060');
    const p9  = get('--p9',  '#8B7355');
    const p10 = get('--p10', '#6B4F3A');
    const p11 = get('--p11', '#4A3B2C');
    const p12 = get('--p12', '#2C231C');

    // ── Métricas de layout ─────────────────────────────────────────────────
    // Alvo de toque mínimo: 44px (WCAG 2.5.5 / Apple HIG)
    const TEMA_H      = 52;    // era 44
    const FASE_H      = 44;    // era 32  ← principal ganho ergonómico
    const FASE_R      = 12;    // rx das fases
    const TEMA_R      = 18;
    const FASE_FONT   = 13;    // era 11
    const TEMA_FONT   = 15;    // era 13
    const FASE_GAP    = 44;    // era 36 — mais espaço entre alvos
    const FASE_PAD_X  = 20;    // padding horizontal mínimo por fase
    const THEME_GAP   = 200;   // era 180 — acomodar fases mais altas
    const FASE_Y_OFF  = 110;   // era 95
    const PADDING_X   = 200;
    const PADDING_TOP = 120;

    // Largura das fases calculada para garantir legibilidade
    const faseInfosPorTema = temas.map(temaObj => {
        const fases = Array.isArray(temaObj.subtemas) ? temaObj.subtemas : [];
        return fases.map(fase => {
            // Aproximação conservadora: 8px/char + padding generoso
            const faseWidth = Math.max(100, fase.length * 8 + FASE_PAD_X * 2);
            return { texto: fase, width: faseWidth };
        });
    });

    const maxRowWidth = Math.max(
        900,
        ...faseInfosPorTema.map(infos =>
            infos.length
                ? infos.reduce((s, f) => s + f.width, 0) + FASE_GAP * (infos.length - 1)
                : 0
        )
    );

    const largura    = maxRowWidth + PADDING_X * 2;
    const alturaTotal = PADDING_TOP + temas.length * THEME_GAP + 160;
    const centroX    = largura / 2;

    svg.setAttribute("viewBox", `0 0 ${largura} ${alturaTotal}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // ── Helper SVG ─────────────────────────────────────────────────────────
    const svgEl = (tag, attrs) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
    };

    const animateIn = (group, delay) => {
        group.setAttribute("opacity", "0");
        group.setAttribute("transform", "translate(0 12)");

        const fade = svgEl("animate", {
            attributeName: "opacity", from: "0", to: "1",
            dur: "0.4s", begin: `${delay}s`, fill: "freeze"
        });
        const move = svgEl("animateTransform", {
            attributeName: "transform", type: "translate",
            from: "0 12", to: "0 0",
            dur: "0.4s", begin: `${delay}s`, fill: "freeze"
        });
        group.appendChild(fade);
        group.appendChild(move);
    };

    // ── Botão Seguir ───────────────────────────────────────────────────────
    const seguirBtnId = "seguirDisciplinaBtn";
    let seguirBtn = document.getElementById(seguirBtnId);
    if (!seguirBtn) {
        seguirBtn = document.createElement("button");
        seguirBtn.id = seguirBtnId;
        seguirBtn.type = "button";
        seguirBtn.className = "seguir-disciplina-btn";
        container.appendChild(seguirBtn);
    }
    seguirBtn.dataset.disciplina = disciplina;

    const feedbackId = "seguirDisciplinaFeedback";
    let feedback = document.getElementById(feedbackId);
    if (!feedback) {
        feedback = document.createElement("div");
        feedback.id = feedbackId;
        feedback.className = "seguir-disciplina-feedback";
        container.appendChild(feedback);
    }

    // ── Renderizar nós ─────────────────────────────────────────────────────
    for (let i = 0; i < temas.length; i++) {
        const temaObj  = temas[i];
        const tema     = temaObj.nome;
        const faseInfos = faseInfosPorTema[i];

        const x = centroX;
        const y = PADDING_TOP + i * THEME_GAP;

        // Nó tema
        const temaWidth = Math.max(260, tema.length * 9 + 80);
        const temaGroup = document.createElementNS(NS, "g");
        temaGroup.setAttribute("aria-label", tema);
        animateIn(temaGroup, i * 0.07);

        temaGroup.appendChild(svgEl("rect", {
            x: x - temaWidth / 2, y: y - TEMA_H / 2,
            width: temaWidth, height: TEMA_H,
            rx: TEMA_R, ry: TEMA_R,
            fill: p8, stroke: p6, "stroke-width": "2",
            filter: "url(#shadowTema)"
        }));
        temaGroup.appendChild(svgEl("text", {
            x, y, "text-anchor": "middle", "dominant-baseline": "middle",
            fill: p1, "font-size": TEMA_FONT, "font-weight": "700",
            "font-family": "'Inter','Segoe UI',sans-serif",
            "letter-spacing": "0.3"
        })).textContent = tema;

        svgContent.appendChild(temaGroup);

        // Nós de fase
        const totalFaseWidth = faseInfos.length
            ? faseInfos.reduce((s, f) => s + f.width, 0) + FASE_GAP * (faseInfos.length - 1)
            : 0;
        let cursorX = x - totalFaseWidth / 2;

        for (let j = 0; j < faseInfos.length; j++) {
            const faseInfo  = faseInfos[j];
            const faseWidth = faseInfo.width;
            const fx = cursorX + faseWidth / 2;
            const fy = y + FASE_Y_OFF;

            // Linha de ligação
            const startY = y + TEMA_H / 2;
            const endY   = fy - FASE_H / 2;
            const c1Y    = startY + 30;
            const c2Y    = endY   - 30;
            svgContent.appendChild(svgEl("path", {
                d: `M ${x} ${startY} C ${x} ${c1Y}, ${fx} ${c2Y}, ${fx} ${endY}`,
                fill: "none", stroke: p7, "stroke-width": "1.5",
                "stroke-linecap": "round", "stroke-opacity": "0.6",
                "stroke-dasharray": "4 3"
            }));

            // Grupo interactivo da fase
            const grupo = document.createElementNS(NS, "g");
            grupo.setAttribute("class", "fase-node");
            grupo.setAttribute("role", "button");
            grupo.setAttribute("tabindex", "0");
            grupo.setAttribute("aria-label", `Abrir subtema: ${faseInfo.texto}`);
            grupo.style.cursor = "pointer";
            animateIn(grupo, i * 0.07 + j * 0.04 + 0.1);

            // Rectângulo de hit-area completo (garante 44px de altura de toque)
            grupo.appendChild(svgEl("rect", {
                x: fx - faseWidth / 2, y: fy - FASE_H / 2,
                width: faseWidth, height: FASE_H,
                rx: FASE_R, ry: FASE_R,
                fill: p10, stroke: p6, "stroke-width": "1.5",
                filter: "url(#shadowFase)",
                class: "fase-rect"
            }));

            // Pequeno indicador de acção (seta ›) à direita do texto
            const faseLabel = document.createElementNS(NS, "text");
            faseLabel.setAttribute("x", String(fx));
            faseLabel.setAttribute("y", String(fy));
            faseLabel.setAttribute("text-anchor", "middle");
            faseLabel.setAttribute("dominant-baseline", "middle");
            faseLabel.setAttribute("fill", p1);
            faseLabel.setAttribute("font-size", String(FASE_FONT));
            faseLabel.setAttribute("font-weight", "600");
            faseLabel.setAttribute("font-family", "'Inter','Segoe UI',sans-serif");
            faseLabel.textContent = faseInfo.texto;
            grupo.appendChild(faseLabel);

            // Hover visual — glow no rect
            const faseRect = grupo.querySelector(".fase-rect") || grupo.firstElementChild;
            grupo.addEventListener("mouseenter", () => {
                faseRect.setAttribute("filter", "url(#glowFase)");
                faseRect.setAttribute("stroke", p1);
            });
            grupo.addEventListener("mouseleave", () => {
                faseRect.setAttribute("filter", "url(#shadowFase)");
                faseRect.setAttribute("stroke", p6);
            });

            const abrirSubtema = () => abrirConteudoFase({
                disciplina, nome: tema,
                subtema: faseInfo.texto, tema, fase: faseInfo.texto
            });

            grupo.addEventListener("click", abrirSubtema);
            grupo.addEventListener("keydown", e => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirSubtema(); }
            });

            svgContent.appendChild(grupo);
            cursorX += faseWidth + FASE_GAP;
        }
    }

    // ── Pan & Zoom (mouse + touch + wheel) ────────────────────────────────
    // Usa transformação no viewBox — comportamento correcto a qualquer escala
    let vbX = 0, vbY = 0, vbW = largura, vbH = alturaTotal;
    const SCALE_MIN = 0.25, SCALE_MAX = 4;

    function setViewBox() {
        svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    }

    function zoomAround(cx, cy, factor) {
        // factor > 1 = zoom in, < 1 = zoom out
        const newW = Math.min(largura * (1 / SCALE_MIN), Math.max(largura * (1 / SCALE_MAX), vbW / factor));
        const newH = Math.min(alturaTotal * (1 / SCALE_MIN), Math.max(alturaTotal * (1 / SCALE_MAX), vbH / factor));
        // Manter o ponto (cx,cy) fixo
        const svgRect = svg.getBoundingClientRect();
        const ratioX  = (cx - svgRect.left) / svgRect.width;
        const ratioY  = (cy - svgRect.top)  / svgRect.height;
        vbX += ratioX * (vbW - newW);
        vbY += ratioY * (vbH - newH);
        vbW  = newW;
        vbH  = newH;
        setViewBox();
    }

    function resetView() {
        vbX = 0; vbY = 0; vbW = largura; vbH = alturaTotal;
        setViewBox();
    }

    // Mouse pan
    let isPanning = false, panStart = { x: 0, y: 0 };
    svg.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
        svg.style.cursor = "grabbing";
        e.preventDefault();
    });
    window.addEventListener("mouseup", () => {
        if (!isPanning) return;
        isPanning = false;
        svg.style.cursor = "grab";
    });
    window.addEventListener("mousemove", e => {
        if (!isPanning) return;
        const svgRect = svg.getBoundingClientRect();
        const dx = -(e.clientX - panStart.x) * (vbW / svgRect.width);
        const dy = -(e.clientY - panStart.y) * (vbH / svgRect.height);
        vbX += dx; vbY += dy;
        panStart = { x: e.clientX, y: e.clientY };
        setViewBox();
    });
    svg.style.cursor = "grab";

    // Wheel zoom
    svg.addEventListener("wheel", e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoomAround(e.clientX, e.clientY, factor);
    }, { passive: false });

    // Touch: pan com 1 dedo, pinch-zoom com 2
    let lastTouches = null;
    svg.addEventListener("touchstart", e => {
        e.preventDefault();
        lastTouches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
    }, { passive: false });

    svg.addEventListener("touchmove", e => {
        e.preventDefault();
        const touches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
        const svgRect  = svg.getBoundingClientRect();

        if (touches.length === 1 && lastTouches?.length === 1) {
            // Pan
            const dx = -(touches[0].x - lastTouches[0].x) * (vbW / svgRect.width);
            const dy = -(touches[0].y - lastTouches[0].y) * (vbH / svgRect.height);
            vbX += dx; vbY += dy;
            setViewBox();
        } else if (touches.length === 2 && lastTouches?.length === 2) {
            // Pinch zoom
            const prevDist = Math.hypot(lastTouches[1].x - lastTouches[0].x, lastTouches[1].y - lastTouches[0].y);
            const currDist = Math.hypot(touches[1].x     - touches[0].x,     touches[1].y     - touches[0].y);
            if (prevDist > 0) {
                const midX = (touches[0].x + touches[1].x) / 2;
                const midY = (touches[0].y + touches[1].y) / 2;
                zoomAround(midX, midY, currDist / prevDist);
            }
        }
        lastTouches = touches;
    }, { passive: false });

    svg.addEventListener("touchend", () => { lastTouches = null; });

    // ── Painel de controlos (agrupado, canto inferior-esquerdo) ───────────
    // Posicionado em CSS via classe .mapa-ctrl-panel — não inline
    const ctrlPanel = document.createElement("div");
    ctrlPanel.className = "mapa-ctrl-panel mapa-ctrl-btn";

    const mkBtn = (label, ariaLabel, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mapa-ctrl-btn-item";
        btn.setAttribute("aria-label", ariaLabel);
        btn.innerHTML = label;
        btn.addEventListener("click", onClick);
        return btn;
    };

    ctrlPanel.appendChild(mkBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        "Zoom +", () => zoomAround(
            svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2,
            svg.getBoundingClientRect().top  + svg.getBoundingClientRect().height / 2,
            1.25
        )
    ));
    ctrlPanel.appendChild(mkBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        "Zoom −", () => zoomAround(
            svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2,
            svg.getBoundingClientRect().top  + svg.getBoundingClientRect().height / 2,
            1 / 1.25
        )
    ));
    ctrlPanel.appendChild(mkBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8a5 5 0 1 0 10 0A5 5 0 0 0 3 8Zm5-2v4M6 8h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        "Centrar mapa", resetView
    ));

    container.appendChild(ctrlPanel);
    container.classList.add("show");

    await atualizarEstadoSeguimento(seguirBtn, disciplina);
}

async function atualizarEstadoSeguimento(button, disciplina) {
    if (!button) return;
    button.disabled = true;
    button.textContent = "A verificar...";
    try {
        const response = await authenticatedFetch(`${API_URL}/disciplinas/seguindo`);
        const data = await response.json().catch(() => ({}));
        const lista = Array.isArray(data.disciplinas) ? data.disciplinas : [];
        const seguindo = lista.some((item) => normalizarTexto(item) === normalizarTexto(disciplina));
        button.dataset.seguindo = seguindo ? "1" : "0";
        button.textContent = seguindo ? "A seguir" : "Seguir";
    } catch (error) {
        console.error("Erro ao verificar seguimento:", error);
        button.textContent = "Seguir";
    } finally {
        button.disabled = false;
    }
}

function mostrarFeedbackSeguimento(mensagem, tipo = "ok") {
    const feedback = document.getElementById("seguirDisciplinaFeedback");
    if (!feedback) return;
    feedback.textContent = mensagem;
    feedback.classList.remove("ok", "erro", "show");
    feedback.classList.add(tipo === "erro" ? "erro" : "ok");
    feedback.classList.add("show");
    window.clearTimeout(mostrarFeedbackSeguimento._timer);
    mostrarFeedbackSeguimento._timer = window.setTimeout(() => {
        feedback.classList.remove("show");
    }, 2200);
}

document.addEventListener("click", async (event) => {
    const btn = event.target.closest(".seguir-disciplina-btn");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const disciplina = btn.dataset.disciplina;
    if (!disciplina) return;
    const seguindo = btn.dataset.seguindo === "1";
    btn.disabled = true;
    btn.textContent = seguindo ? "A remover..." : "A seguir...";
    try {
        const response = await authenticatedFetch(`${API_URL}/disciplinas/seguir`, {
            method: seguindo ? "DELETE" : "POST",
            body: JSON.stringify({ disciplina })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await atualizarEstadoSeguimento(btn, disciplina);
        mostrarFeedbackSeguimento(seguindo ? "Deixaste de seguir esta disciplina." : "Agora segues esta disciplina.", "ok");
    } catch (error) {
        console.error("Erro ao atualizar seguimento:", error);
        btn.disabled = false;
        btn.textContent = seguindo ? "A seguir" : "Seguir";
        mostrarFeedbackSeguimento("Não foi possível atualizar o seguimento.", "erro");
    }
});

// ============================================
// MODAL DE CONTEÚDO
// ============================================
async function abrirConteudoFase(faseData) {
    const nome = faseData.nome || faseData.tema;
    const subtema = faseData.subtema || faseData.fase;
    document.getElementById("faseTitulo").textContent = subtema;

    const tabConteudo = document.getElementById("tab-conteudo");
    let conteudoHtml = '';

    try {
        const params = new URLSearchParams({
            disciplina: faseData.disciplina,
            nome,
            subtema
        });

        const response = await authenticatedFetch(`${API_URL}/home/fase-conteudo?${params.toString()}`);
        if (response.ok) {
            const data = await response.json();
            conteudoHtml = data.conteudoHtml || '';
            if (Array.isArray(data.autores)) {
                faseData.autores = data.autores;
            } else if (typeof data.autores === 'string') {
                try {
                    const parsed = JSON.parse(data.autores);
                    faseData.autores = Array.isArray(parsed) ? parsed : [];
                } catch (error) {
                    faseData.autores = data.autores.split(/[;,]+/).map((a) => a.trim()).filter(Boolean);
                }
            } else {
                faseData.autores = [];
            }
        }
    } catch (error) {
        console.error("Erro ao carregar conteúdo da fase:", error);
    }

    if (!conteudoHtml) {
        conteudoHtml = `
            <div class="sentinela-bold">Conteúdo de ${escapeHtml(subtema)}</div>
            <p>Conteúdo ainda não cadastrado para esta fase.</p>
        `;
    }

    tabConteudo.innerHTML = "";
    const page = document.createElement("div");
    page.className = "modal-page";

    const content = document.createElement("div");
    content.className = "page-content";
    content.innerHTML = conteudoHtml;
    content.querySelectorAll(".rodape-nota").forEach((nota) => {
        nota.classList.add("rodape-nota", "sc-paragrafo", "referencia", "sc-destaque-referencia-linha");
    });

    const autores = Array.isArray(faseData.autores) ? faseData.autores : [];
    if (autores.length) {
        const blocoAutores = montarBlocoAutores(autores);
        if (blocoAutores) content.appendChild(blocoAutores);
    }

    page.appendChild(content);
    tabConteudo.appendChild(page);

    configurarIndiceConteudo(tabConteudo);

    const modal = document.getElementById("conteudoFaseModal");
    modal.classList.remove("hidden");
    modal.classList.add("show");
    document.body.classList.add("modal-open");

    // In PWA mode, add this opened subtema to the Workspace (Active Documents)
    try {
        const manager = await ActiveDocumentsManager.getInstance();
        const docId = `home:${faseData.disciplina || ''}:${nome}:${subtema}`;
        await manager.openDocument({
            id: docId,
            title: subtema,
            type: 'Subtema',
            route: '/app/home',
            params: {
                disciplina: faseData.disciplina,
                nome,
                subtema,
            },
            metadata: {
                disciplina: faseData.disciplina,
                tema: nome,
                subtema,
                openedAt: Date.now(),
            }
        });
    } catch (err) {
        // ignore if not PWA or manager unavailable
        console.debug('ActiveDocumentsManager not available or not in PWA mode:', err?.message || err);
    }
}

function configurarIndiceConteudo(tabConteudo) {
    if (!tabConteudo) return;
    const modal = document.querySelector("#conteudoFaseModal .conteudo-modal");
    const links = tabConteudo.querySelectorAll(".docx-toc a[href^='#']");
    if (!links.length) return;

    links.forEach((link) => {
        const href = link.getAttribute("href") || "";
        const id = href.startsWith("#") ? href.slice(1) : "";
        if (!id) return;
        link.dataset.target = id;
        link.setAttribute("href", "javascript:void(0)");
        link.setAttribute("role", "button");
    });

    if (tabConteudo.dataset.tocBound === "1") return;
    tabConteudo.dataset.tocBound = "1";

    const encontrarDestinoPorTexto = (tituloIndice = "") => {
        const alvoNormalizado = normalizarTexto(tituloIndice);
        if (!alvoNormalizado) return null;

        const headingCandidates = Array.from(
            tabConteudo.querySelectorAll("h1, h2, h3, h4, h5, h6, .sc-titulo")
        );
        if (!headingCandidates.length) return null;

        let melhor = null;
        let melhorScore = 0;

        headingCandidates.forEach((el) => {
            const texto = normalizarTexto(el.textContent || "");
            if (!texto) return;

            let score = 0;
            if (texto === alvoNormalizado) {
                score = 100;
            } else if (texto.includes(alvoNormalizado)) {
                score = 80;
            } else if (alvoNormalizado.includes(texto)) {
                score = 60;
            } else {
                const tokens = alvoNormalizado.split(" ").filter(Boolean);
                const matches = tokens.filter((t) => texto.includes(t)).length;
                if (matches > 0) {
                    score = Math.floor((matches / tokens.length) * 50);
                }
            }

            if (score > melhorScore) {
                melhor = el;
                melhorScore = score;
            }
        });

        return melhorScore >= 35 ? melhor : null;
    };

    const headingSelector = "h1, h2, h3, h4, h5, h6, .sc-titulo";
    const obterHeadingsDocumento = () =>
        Array.from(tabConteudo.querySelectorAll(headingSelector))
            .filter((el) => !el.closest(".docx-toc"));

    const encontrarHeadingMaisProximo = (baseEl) => {
        if (!baseEl) return null;
        if (baseEl.matches?.(headingSelector) && !baseEl.closest(".docx-toc")) return baseEl;

        const parentHeading = baseEl.closest?.(headingSelector);
        if (parentHeading) return parentHeading;

        const headings = obterHeadingsDocumento();
        if (!headings.length) return null;

        const firstFollowing = headings.find((heading) => {
            const relation = baseEl.compareDocumentPosition(heading);
            return Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        if (firstFollowing) return firstFollowing;

        for (let i = headings.length - 1; i >= 0; i -= 1) {
            const heading = headings[i];
            const relation = baseEl.compareDocumentPosition(heading);
            if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
                return heading;
            }
        }
        return null;
    };

    const inferirHeadingPorOrdem = (anchor) => {
        const headings = obterHeadingsDocumento();
        if (!headings.length) return null;
        const allTocAnchors = Array.from(tabConteudo.querySelectorAll(".docx-toc a[data-target]"));
        const idx = allTocAnchors.indexOf(anchor);
        if (idx < 0) return null;
        return headings[Math.min(idx, headings.length - 1)] || null;
    };

    const resolverDestinoIndice = (anchor) => {
        const id = anchor?.dataset?.target;
        if (id) {
            let scoped = null;
            try {
                scoped = tabConteudo.querySelector(`#${CSS.escape(id)}`);
            } catch (error) {
                // ID inválido para seletor CSS; segue para fallback textual.
            }

            if (!scoped) {
                scoped = tabConteudo.querySelector(`[name="${id.replace(/"/g, '\\"')}"]`);
            }

            if (scoped && !scoped.closest(".docx-toc")) {
                return encontrarHeadingMaisProximo(scoped) || scoped;
            }

            const globalMatch = document.getElementById(id);
            if (globalMatch && tabConteudo.contains(globalMatch) && !globalMatch.closest(".docx-toc")) {
                return encontrarHeadingMaisProximo(globalMatch) || globalMatch;
            }
        }
        const porTexto = encontrarDestinoPorTexto(anchor?.textContent || "");
        if (porTexto) return porTexto;
        return inferirHeadingPorOrdem(anchor);
    };

    const destacarDestino = (target) => {
        if (!target) return;
        if (target.dataset.highlightTimer) {
            clearTimeout(Number(target.dataset.highlightTimer));
        }
        target.classList.remove("toc-target-highlight");
        void target.offsetWidth;
        target.classList.add("toc-target-highlight");
        const timerId = window.setTimeout(() => {
            target.classList.remove("toc-target-highlight");
            delete target.dataset.highlightTimer;
        }, 1200);
        target.dataset.highlightTimer = String(timerId);
    };

    const TOC_SCROLL_NUDGE_DOWN_PX = 82;

    tabConteudo.addEventListener("click", (event) => {
        const anchor = event.target.closest(".docx-toc a[data-target]");
        if (!anchor || !tabConteudo.contains(anchor)) return;
        const target = resolverDestinoIndice(anchor);
        if (!target) return;
        event.preventDefault();

        if (modal) {
            const modalRect = modal.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const absoluteTop = modal.scrollTop + (targetRect.top - modalRect.top);
            const desiredTop = Math.max(0, absoluteTop + TOC_SCROLL_NUDGE_DOWN_PX);
            modal.scrollTo({ top: desiredTop, behavior: "smooth" });
        } else {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            window.scrollBy({ top: TOC_SCROLL_NUDGE_DOWN_PX, left: 0, behavior: "smooth" });
        }
        destacarDestino(target);
    });
}

function montarBlocoAutores(autores) {
    if (!autores.length) return null;
    const bloco = document.createElement('div');
    bloco.className = 'autor-bloco';

    autores.forEach((autor) => {
        const row = document.createElement('div');
        row.className = 'autor-row';

        const prefixo = document.createElement('span');
        prefixo.className = 'autor-prefixo';
        prefixo.textContent = 'Por';

        const nomeBtn = document.createElement('button');
        nomeBtn.type = 'button';
        nomeBtn.className = 'autor-link';
        nomeBtn.textContent = autor;
        nomeBtn.addEventListener('click', () => abrirModalAutor(autor));

        const gestor = gestoresByNome.get(normalizarNomeAutor(autor));
        const desc = document.createElement('div');
        desc.className = 'autor-desc';
        desc.textContent = gestor?.descricao || '';

        row.appendChild(prefixo);
        row.appendChild(nomeBtn);
        row.appendChild(desc);
        bloco.appendChild(row);
    });

    return bloco;
}

function fecharConteudoModal() {
    const modal = document.getElementById("conteudoFaseModal");
    modal.classList.remove("show");
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
}

// ============================================
// EVENT LISTENERS GLOBAIS
// ============================================
function setupEventListeners() {
    // Fechar modal de etapas ao clicar fora
    document.addEventListener('click', function (event) {
        const modal = document.getElementById('etapasModal');
        const conteudo = document.querySelector('.etapas-modal-content');
        
        if (event.target.closest('.btn-ver-etapas')) return;

        if (modal && modal.classList.contains('show') && conteudo && !conteudo.contains(event.target)) {
            modal.classList.remove('show');
        }
    });

    // Fechar SVG ao clicar fora
    document.addEventListener("click", (e) => {
        const svgContainer = document.getElementById("svgMapaContainer");
        const svgMapa = document.getElementById("svgMapa");
        const botaoFechar = document.getElementById("fecharSvgMapaBtn");
        const botaoSeguir = document.getElementById("seguirDisciplinaBtn");

        if (!svgContainer || !svgContainer.classList.contains("show")) return;

        const clicouFora = !svgMapa.contains(e.target)
            && (!botaoFechar || !botaoFechar.contains(e.target))
            && (!botaoSeguir || !botaoSeguir.contains(e.target));
        if (clicouFora) svgContainer.classList.remove("show");
    });

    // Fechar modal de conteúdo com ESC
    document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("conteudoFaseModal");
        if (e.key === "Escape" && modal.classList.contains("show")) {
            fecharConteudoModal();
        }
    });
}

// ============================================
// INICIALIZAÇÃO PRINCIPAL
// ============================================
async function initHome() {
    console.log("🚀 Inicializando Home...");

    // Carregar usuário atual
    currentUser = await getUser();
    currentUserData = await getUserData();

    if (!currentUser) {
        console.warn("⛔ Usuário não autenticado.");
        document.getElementById("conteudoPrincipal").style.display = "none";
        window.location.href = "/index.html";
        return;
    }

    console.log("✅ Usuário autenticado:", currentUser);

    const linkEditorConteudo = document.getElementById("linkEditorConteudo");
    if (linkEditorConteudo) {
        linkEditorConteudo.hidden = !isAdminUser(currentUser);
    }

    // Configurar botões de fechar
    document.getElementById("btnFecharModal")?.addEventListener("click", fecharModalEtapas);
    document.getElementById("fecharSvgMapaBtn")?.addEventListener("click", () => {
        document.getElementById("svgMapaContainer").classList.remove("show");
    });
    document.getElementById("fecharConteudoBtn")?.addEventListener("click", fecharConteudoModal);

    // Fechar modal ao clicar fora
    document.getElementById("conteudoFaseModal")?.addEventListener("click", (e) => {
        if (e.target === e.currentTarget) fecharConteudoModal();
    });

    renderNiveis();
    inicializarCarrosseis();

    // Criar sistema de notificações
    criarSistemaNotificacoes();

    // Carregar notificações
    await carregarNotificacoes();
    await iniciarFluxoNotificacoes();

    // Carregar dashboard
    await carregarDashboard(currentUser.id);

    await carregarGestoresEquipe();
    await carregarConteudosAutores();

    initHiromi();

    if (window.__workspacePendingSummaryId) {
        const pendingId = window.__workspacePendingSummaryId;
        delete window.__workspacePendingSummaryId;
        const card = document.querySelector(`[data-summary-id="${pendingId}"]`);
        card?.querySelector('[data-summary-action="show"]')?.click();
    }

    const pendingSubtema = getPendingSubtemaFromUrl();
    if (pendingSubtema) {
        abrirConteudoFase(pendingSubtema);
    }

    // Configurar event listeners globais
    setupEventListeners();
    window.addEventListener("beforeunload", encerrarFluxoNotificacoes, { once: true });
}

function getPendingSubtemaFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const disciplina = params.get('disciplina');
    const nome = params.get('nome');
    const subtema = params.get('subtema');
    if (!disciplina || !nome || !subtema) {
        return null;
    }
    return {
        disciplina,
        nome,
        subtema,
        fase: subtema,
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initHome().catch((error) => console.error('Erro ao inicializar Home:', error));
    });
} else {
    initHome().catch((error) => console.error('Erro ao inicializar Home:', error));
}

// Exportar função de logout para uso global
window.logout = () => {
    clearCache();
    window.location.href = '/index.html';
};