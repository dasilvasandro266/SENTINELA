const API_URL = '/api';

let currentUser = null;
let currentUserData = null;

const STORAGE_KEY_TOKEN = "token";
const STORAGE_KEY_USER = "user";
const STORAGE_KEY_USER_DATA = "userData";
const STORAGE_KEY_LAST_VERIFIED = "lastVerified";

// Tempo máximo (ms) que os dados em cache podem ser usados sem
// conseguir contactar o servidor, antes de forçarmos logout.
const OFFLINE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos

// Tempo máximo (ms) que esperamos pela resposta do verify-token
// antes de abortar o pedido e cair em modo offline.
const VERIFY_TIMEOUT_MS = 8000;

let currentUserOffline = false;

function fetchWithTimeout(url, options = {}, timeoutMs = VERIFY_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// Inicialização: verificar se já existe token salvo
(async function init() {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const savedUser = localStorage.getItem(STORAGE_KEY_USER);
    
    if (token && savedUser) {
        try {
            // Verificar se token ainda é válido (com timeout)
            const response = await fetchWithTimeout(`${API_URL}/verify-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                currentUser = data.user;
                currentUserData = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_DATA) || '{}');
                currentUserOffline = false;
                localStorage.setItem(STORAGE_KEY_LAST_VERIFIED, String(Date.now()));
                console.log('✅ Sessão restaurada:', currentUser);
            } else {
                // Token inválido, limpar cache
                console.warn('⚠️ Token inválido, limpando sessão');
                clearCache();
            }
        } catch (error) {
            // Falha de rede/timeout: só confiamos na cache se ela ainda
            // estiver "fresca" (verificada com sucesso há pouco tempo).
            // Caso contrário, tratamos como sessão inválida para evitar
            // confiar indefinidamente em dados desatualizados/roubados.
            const lastVerified = Number(localStorage.getItem(STORAGE_KEY_LAST_VERIFIED) || 0);
            const age = Date.now() - lastVerified;

            if (lastVerified && age <= OFFLINE_MAX_AGE_MS) {
                console.warn(`⚠️ Erro ao verificar token, modo offline (cache com ${Math.round(age / 1000)}s):`, error);
                currentUser = JSON.parse(savedUser);
                currentUserData = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_DATA) || '{}');
                currentUserOffline = true;
            } else {
                console.warn('⚠️ Erro ao verificar token e cache expirada/inexistente, a limpar sessão:', error);
                clearCache();
            }
        }
    }
})();

// Promise de inicialização (similar ao original)
const authPromise = new Promise((resolve) => {
    // Já temos currentUser do init, resolver imediatamente
    if (currentUser) {
        resolve({ user: currentUser, data: currentUserData });
    } else {
        // Se não tem usuário, verificar localStorage novamente
        const savedUser = localStorage.getItem(STORAGE_KEY_USER);
        if (savedUser) {
            currentUser = JSON.parse(savedUser);
            currentUserData = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_DATA) || '{}');
            resolve({ user: currentUser, data: currentUserData });
        } else {
            resolve(null);
        }
    }
});

// === Funções públicas (mesma interface do original) ===
export async function getUser() {
    if (currentUser) return currentUser;
    const result = await authPromise;
    return result?.user || null;
}

export async function getUserData() {
    if (currentUserData) return currentUserData;
    const result = await authPromise;
    return result?.data || null;
}

export function clearCache() {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);
    localStorage.removeItem(STORAGE_KEY_USER_DATA);
    localStorage.removeItem(STORAGE_KEY_LAST_VERIFIED);
    currentUser = null;
    currentUserData = null;
    currentUserOffline = false;
}

// Indica se a sessão atual está a ser usada em modo offline (dados em
// cache, sem confirmação recente do servidor). Útil para a UI mostrar
// um aviso ou restringir ações sensíveis nesse estado.
export function isOfflineSession() {
    return currentUserOffline;
}

function showAuthFailureAndRefresh(message = "Sessão inválida. A recarregar...") {
    const existing = document.getElementById("authFailureToast");
    if (existing) return;

    const toast = document.createElement("div");
    toast.id = "authFailureToast";
    toast.textContent = message;
    toast.style.position = "fixed";
    toast.style.left = "50%";
    toast.style.bottom = "24px";
    toast.style.transform = "translateX(-50%)";
    toast.style.zIndex = "99999";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "10px";
    toast.style.background = "rgba(32, 22, 22, 0.95)";
    toast.style.border = "1px solid rgba(255, 120, 120, 0.45)";
    toast.style.color = "#ffe8e8";
    toast.style.fontFamily = "\"Segoe UI\", sans-serif";
    toast.style.fontSize = "13px";
    toast.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
    document.body.appendChild(toast);

    window.setTimeout(() => {
        window.location.reload();
    }, 900);
}

// Função auxiliar para fazer requisições autenticadas
export async function authenticatedFetch(url, options = {}) {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    if (!token) {
        showAuthFailureAndRefresh("Sessão não encontrada. A recarregar...");
        throw new Error('Não autenticado');
    }

    const response = await fetchWithTimeout(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...options.headers
        }
    });

    if (response.status === 401 || response.status === 403) {
        // Token expirado ou inválido
        clearCache();
        showAuthFailureAndRefresh("Falha de autenticação. A recarregar...");
        throw new Error('Sessão expirada');
    }

    if (response.ok && currentUserOffline) {
        // Uma resposta bem-sucedida do servidor confirma que o token
        // ainda é válido, por isso saímos do modo offline e renovamos
        // o carimbo de "última verificação".
        currentUserOffline = false;
        localStorage.setItem(STORAGE_KEY_LAST_VERIFIED, String(Date.now()));
    }

    return response;
}

export function isAdminUser(user) {
    return user?.isAdmin === true || user?.isAdmin === 1 || user?.isAdmin === "1";
}
