const API_URL = '/api';

let currentUser = null;
let currentUserData = null;

const STORAGE_KEY_TOKEN = "token";
const STORAGE_KEY_USER = "user";
const STORAGE_KEY_USER_DATA = "userData";

// Inicialização: verificar se já existe token salvo
(async function init() {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const savedUser = localStorage.getItem(STORAGE_KEY_USER);
    
    if (token && savedUser) {
        try {
            // Verificar se token ainda é válido
            const response = await fetch(`${API_URL}/verify-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                currentUser = data.user;
                currentUserData = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_DATA) || '{}');
                console.log('✅ Sessão restaurada:', currentUser);
            } else {
                // Token inválido, limpar cache
                console.warn('⚠️ Token inválido, limpando sessão');
                clearCache();
            }
        } catch (error) {
            console.warn('⚠️ Erro ao verificar token, modo offline:', error);
            // Modo offline: usar dados salvos
            currentUser = JSON.parse(savedUser);
            currentUserData = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_DATA) || '{}');
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
    currentUser = null;
    currentUserData = null;
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

    const response = await fetch(url, {
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

    return response;
}

export function isAdminUser(user) {
    return user?.isAdmin === true || user?.isAdmin === 1 || user?.isAdmin === "1";
}
