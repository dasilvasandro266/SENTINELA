import { authenticatedFetch, clearCache, getUser, isAdminUser } from "./authManager.js";

const API_URL = "/api";

const nomeUsuarioEl = document.getElementById("nomeUsuario");
const instituicaoEl = document.getElementById("instituicao");
const tipoContaBadgeEl = document.getElementById("tipoContaBadge");
const avatarEl = document.getElementById("avatarPerfil");
const conteudoAbas = document.querySelectorAll(".secao");
const mensagemAtualizacao = document.getElementById("mensagemAtualizacao");
const formAtualizar = document.getElementById("formAtualizar");
const disciplinasSeguidasEl = document.getElementById("disciplinasSeguidas");

let currentUser = null;

function atualizarBadgeConta(user) {
    const admin = isAdminUser(user);
    if (tipoContaBadgeEl) {
        tipoContaBadgeEl.textContent = admin ? "Conta Admin" : "Conta Usuário";
        tipoContaBadgeEl.dataset.role = admin ? "admin" : "user";
    }
}

function preencherPerfil(user) {
    if (nomeUsuarioEl) nomeUsuarioEl.textContent = user.nome_completo || user.username || "Usuário";
    if (instituicaoEl) instituicaoEl.textContent = user.instituicao || "-";
    const novaInstituicaoEl = document.getElementById("novaInstituicao");
    if (novaInstituicaoEl) novaInstituicaoEl.value = user.instituicao || "";
    atualizarBadgeConta(user);

    const nome = user.nome_completo || user.username || "Usuário";
    if (avatarEl) {
        avatarEl.textContent = nome.charAt(0).toUpperCase();
        avatarEl.classList.remove("loading");
    }
}

async function carregarPerfil() {
    const response = await authenticatedFetch(`${API_URL}/user/me`);
    if (!response.ok) throw new Error("Falha ao carregar perfil");
    const user = await response.json();
    currentUser = user;
    preencherPerfil(user);
}

async function carregarDisciplinasSeguidas() {
    if (!disciplinasSeguidasEl) return;
    disciplinasSeguidasEl.innerHTML = "";
    try {
        const response = await authenticatedFetch(`${API_URL}/disciplinas/seguindo`);
        const data = await response.json().catch(() => ({}));
        const lista = Array.isArray(data.disciplinas) ? data.disciplinas : [];
        if (!lista.length) {
            const li = document.createElement("li");
            li.className = "empty";
            li.textContent = "Ainda não segues nenhuma disciplina.";
            disciplinasSeguidasEl.appendChild(li);
            return;
        }
        lista.forEach((disciplina) => {
            const li = document.createElement("li");
            li.textContent = disciplina;
            disciplinasSeguidasEl.appendChild(li);
        });
    } catch (error) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Não foi possível carregar as disciplinas.";
        disciplinasSeguidasEl.appendChild(li);
        console.error("Erro ao carregar disciplinas seguidas:", error);
    }
}

window.mostrarSecao = function mostrarSecao(id) {
    conteudoAbas.forEach((secao) => {
        secao.style.display = "none";
        secao.classList.remove("ativa");
    });
    const secao = document.getElementById(id);
    if (secao) {
        secao.style.display = "block";
        secao.classList.add("ativa");
    }
};

window.logout = function logout() {
    clearCache();
    window.location.href = "/index.html";
};

window.confirmarExclusao = async function confirmarExclusao() {
    const confirmar = confirm("Tem certeza que deseja excluir sua conta? Esta ação é irreversível.");
    if (!confirmar) return;
    try {
        const response = await authenticatedFetch(`${API_URL}/user/me`, { method: "DELETE" });
        if (!response.ok) throw new Error("Falha ao eliminar conta");
        clearCache();
        window.location.href = "/index.html";
    } catch (error) {
        alert("Erro ao eliminar conta.");
        console.error(error);
    }
};

if (formAtualizar) {
    formAtualizar.addEventListener("submit", async (e) => {
        e.preventDefault();
        const novaInstituicao = document.getElementById("novaInstituicao")?.value || "";

        if (!novaInstituicao.trim()) {
            if (mensagemAtualizacao) {
                mensagemAtualizacao.textContent = "Informe a instituição.";
                mensagemAtualizacao.style.color = "orange";
            }
            return;
        }

        try {
            const response = await authenticatedFetch(`${API_URL}/user/me`, {
                method: "PATCH",
                body: JSON.stringify({
                    instituicao: novaInstituicao.trim()
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Erro ao atualizar");

            if (mensagemAtualizacao) {
                mensagemAtualizacao.textContent = "Dados atualizados com sucesso!";
                mensagemAtualizacao.style.color = "lightgreen";
            }
            if (data.user) {
                currentUser = data.user;
                preencherPerfil(currentUser);
                localStorage.setItem("user", JSON.stringify(currentUser));
            }
        } catch (error) {
            if (mensagemAtualizacao) {
                mensagemAtualizacao.textContent = "Erro ao atualizar dados.";
                mensagemAtualizacao.style.color = "red";
            }
            console.error(error);
        }
    });
}

async function initPerfil() {
    const menuButton = document.querySelector(".menu-button");
    const toolbarMenu = document.getElementById("toolbar-menu");
    if (menuButton && toolbarMenu) {
        menuButton.addEventListener("click", () => toolbarMenu.classList.toggle("active"));
    }

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", window.logout);

    const deleteBtn = document.getElementById("deleteAccountBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", window.confirmarExclusao);

    const user = await getUser();
    if (!user) {
        window.location.href = "/index.html";
        return;
    }

    await carregarPerfil();
    await carregarDisciplinasSeguidas();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        initPerfil().catch((error) => console.error("Erro ao inicializar perfil:", error));
    });
} else {
    initPerfil().catch((error) => console.error("Erro ao inicializar perfil:", error));
}
