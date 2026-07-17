import { authenticatedFetch, getUser, isAdminUser } from "../authManager.js";

const API_URL = "/api";

const adminStatusBadge = document.getElementById("adminStatusBadge");
const formResgatarAdmin = document.getElementById("formResgatarAdmin");
const mensagemAdminKey = document.getElementById("mensagemAdminKey");
const formBootstrapAdmin = document.getElementById("formBootstrapAdmin");
const mensagemBootstrapKey = document.getElementById("mensagemBootstrapKey");
const bootstrapPanel = document.getElementById("bootstrapPanel");
const bootstrapHint = document.getElementById("bootstrapHint");
const bootstrapAdminInput = document.getElementById("bootstrapAdminInput");
const adminKeyGenerator = document.getElementById("adminKeyGenerator");
const formGerarAdminKey = document.getElementById("formGerarAdminKey");
const mensagemGerarAdminKey = document.getElementById("mensagemGerarAdminKey");
const ttlAdminKeyInput = document.getElementById("ttlAdminKeyInput");
const indefiniteAdminKeyInput = document.getElementById("indefiniteAdminKeyInput");
const adminsListPanel = document.getElementById("adminsListPanel");
const adminsList = document.getElementById("adminsList");
const auditPanel = document.getElementById("auditPanel");
const adminAuditList = document.getElementById("adminAuditList");

let currentUser = null;
let bootstrapAvailable = false;

function setMessage(el, text, color = "rgba(245, 240, 230, 0.7)") {
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function adminLabel(role) {
  if (role === "bootstrap") return "Admin bootstrap";
  if (role === "content") return "Gestão de conteúdo";
  if (role === "general") return "Admin geral";
  return "Sem privilégios";
}

function hasCapability(user, capability) {
  return Array.isArray(user?.adminCapabilities) && user.adminCapabilities.includes(capability);
}

function canManageAdmins(user) {
  return isAdminUser(user) && hasCapability(user, "admins.manage");
}

function formatDate(value) {
  if (!value) return "Indeterminado";
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function setBootstrapAvailability(available) {
  bootstrapAvailable = available;
  if (!bootstrapPanel || !bootstrapAdminInput || !formBootstrapAdmin) return;
  bootstrapPanel.classList.toggle("admin-disabled", !available);
  bootstrapAdminInput.disabled = !available;
  formBootstrapAdmin.querySelector("button")?.toggleAttribute("disabled", !available);
  if (bootstrapHint) {
    bootstrapHint.textContent = available
      ? "Disponível apenas enquanto ainda não existir uma conta administradora."
      : "Indisponível: já existe pelo menos um administrador ativo.";
  }
}

function updateAdminState(user) {
  const admin = isAdminUser(user);
  if (adminStatusBadge) {
    adminStatusBadge.textContent = admin ? adminLabel(user.adminRole) : "Conta Usuário";
    adminStatusBadge.dataset.role = admin ? "admin" : "user";
  }
  if (adminKeyGenerator) {
    adminKeyGenerator.hidden = !canManageAdmins(user);
  }
  if (adminsListPanel) adminsListPanel.hidden = !canManageAdmins(user);
  if (auditPanel) auditPanel.hidden = !canManageAdmins(user);
}

async function refreshStatus() {
  const response = await authenticatedFetch(`${API_URL}/admin/status`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha ao carregar estado administrativo");
  currentUser = data.user;
  localStorage.setItem("user", JSON.stringify(currentUser));
  setBootstrapAvailability(data.bootstrapAvailable === true);
  updateAdminState(currentUser);
}

function renderAdmins(admins) {
  if (!adminsList) return;
  adminsList.innerHTML = "";
  if (!admins?.length) {
    adminsList.innerHTML = `<div class="admin-row"><span>Nenhum administrador encontrado.</span></div>`;
    return;
  }

  admins.forEach((admin) => {
    const row = document.createElement("div");
    row.className = "admin-row";
    const active = isAdminUser(admin);
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(admin.nome_completo || admin.username || admin.email)}</strong>
        <span>${escapeHtml(admin.email || "")}</span>
        <span class="admin-pill">${active ? adminLabel(admin.adminRole) : "Revogado"}</span>
        <span>Promovido por: ${escapeHtml(admin.promotedByUsername || "bootstrap/sistema")} · Expira: ${formatDate(admin.adminExpiresAt)}</span>
      </div>
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Despromover";
    button.disabled = !active || !admin.canRevoke;
    button.title = button.disabled ? "Só o promotor original ou o bootstrap pode despromover." : "Retirar privilégios";
    button.addEventListener("click", async () => revokeAdmin(admin.id));
    row.appendChild(button);
    adminsList.appendChild(row);
  });
}

function renderAudit(logs) {
  if (!adminAuditList) return;
  adminAuditList.innerHTML = "";
  if (!logs?.length) {
    adminAuditList.innerHTML = `<div class="audit-row"><span>Sem eventos administrativos registados.</span></div>`;
    return;
  }

  logs.forEach((log) => {
    const meta = log.meta && typeof log.meta === "object" ? log.meta : {};
    const row = document.createElement("button");
    const detailsId = `audit-${log.id}`;
    row.className = "audit-row";
    row.type = "button";
    const title = meta.titulo || meta.nome || meta.id || meta.targetUserId || log.event_type;
    const action = meta.action === "delete" ? "Eliminação" : meta.action === "upload" ? "Upload/atualização" : log.event_type;
    const details = [
      ["Título", meta.titulo || meta.nome],
      ["Disciplina", meta.disciplina],
      ["Tema", meta.tema],
      ["Subtema", meta.subtema || meta.fase],
      ["Autor/autores", Array.isArray(meta.autores) ? meta.autores.map((a) => a.nome || a).join(", ") : meta.autores],
      ["Tribunal", meta.tribunal],
      ["Ano", meta.ano],
      ["Admin do upload", meta.uploadedBy || (meta.action === "upload" ? log.username || log.user_id : null)],
      ["Admin da ação", log.username || log.user_id || "sistema"],
      ["Horário do upload", formatDate(meta.uploadedAt || log.created_at)],
      ["Horário da eliminação", meta.deletedAt ? formatDate(meta.deletedAt) : null],
      ["Fundamentação", meta.reason]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");

    row.innerHTML = `
      <strong>${escapeHtml(action)}: ${escapeHtml(title)}</strong>
      <span>Por: ${escapeHtml(log.username || log.user_id || "sistema")} ${meta.targetUserId ? `· Alvo: ${escapeHtml(meta.targetUserId)}` : ""}</span>
      <time>${formatDate(log.created_at)}</time>
      <div class="audit-details" id="${detailsId}" hidden>
        ${details.map(([label, value]) => `<p><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>`).join("")}
      </div>
    `;
    row.addEventListener("click", () => {
      const detailsEl = row.querySelector(".audit-details");
      if (!detailsEl) return;
      detailsEl.hidden = !detailsEl.hidden;
      row.classList.toggle("is-expanded", !detailsEl.hidden);
    });
    adminAuditList.appendChild(row);
  });
}

async function loadAdminData() {
  if (!canManageAdmins(currentUser)) return;
  const [adminsResponse, auditResponse] = await Promise.all([
    authenticatedFetch(`${API_URL}/admin/users`),
    authenticatedFetch(`${API_URL}/admin/audit-logs`)
  ]);
  const adminsData = await adminsResponse.json().catch(() => ({}));
  const auditData = await auditResponse.json().catch(() => ({}));
  if (adminsResponse.ok) renderAdmins(adminsData.admins || []);
  if (auditResponse.ok) renderAudit(auditData.logs || []);
}

async function revokeAdmin(userId) {
  if (!confirm("Retirar privilégios administrativos desta conta?")) return;
  const response = await authenticatedFetch(`${API_URL}/admin/users/${encodeURIComponent(userId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason: "Revogado pelo painel administrativo" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    alert(data.error || "Falha ao retirar privilégios.");
    return;
  }
  await refreshStatus();
  await loadAdminData();
}

if (formResgatarAdmin) formResgatarAdmin.addEventListener("submit", async (e) => {
  e.preventDefault();
  const accessKey = document.getElementById("chaveAdminInput").value.trim();
  if (!accessKey) {
    setMessage(mensagemAdminKey, "Informe a chave privada.", "orange");
    return;
  }

  try {
    const response = await authenticatedFetch(`${API_URL}/admin/redeem-key`, {
      method: "POST",
      body: JSON.stringify({ accessKey })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Falha ao resgatar chave");

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    currentUser = data.user;
    updateAdminState(currentUser);

    setMessage(mensagemAdminKey, "Conta promovida com sucesso.", "lightgreen");
    document.getElementById("chaveAdminInput").value = "";
    await refreshStatus();
    await loadAdminData();
  } catch (error) {
    setMessage(mensagemAdminKey, error.message || "Erro ao resgatar chave.", "red");
  }
});

if (formBootstrapAdmin) formBootstrapAdmin.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!bootstrapAvailable) {
    setMessage(mensagemBootstrapKey, "Bootstrap indisponível: já existe administrador ativo.", "orange");
    return;
  }

  const bootstrapKey = bootstrapAdminInput.value.trim();
  if (!bootstrapKey) {
    setMessage(mensagemBootstrapKey, "Informe a chave de bootstrap.", "orange");
    return;
  }

  try {
    const response = await authenticatedFetch(`${API_URL}/admin/bootstrap`, {
      method: "POST",
      body: JSON.stringify({ bootstrapKey })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Falha no bootstrap");

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    currentUser = data.user;
    updateAdminState(currentUser);

    setMessage(mensagemBootstrapKey, "Bootstrap concluído. Esta conta é admin principal.", "lightgreen");
    bootstrapAdminInput.value = "";
    await refreshStatus();
    await loadAdminData();
  } catch (error) {
    setMessage(mensagemBootstrapKey, error.message || "Erro no bootstrap.", "red");
  }
});

if (indefiniteAdminKeyInput && ttlAdminKeyInput) {
  indefiniteAdminKeyInput.addEventListener("change", () => {
    ttlAdminKeyInput.disabled = indefiniteAdminKeyInput.checked;
  });
}

if (formGerarAdminKey) formGerarAdminKey.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canManageAdmins(currentUser)) {
    setMessage(mensagemGerarAdminKey, "Sem capacidade para promover administradores.", "orange");
    return;
  }

  const role = document.getElementById("roleAdminKeyInput").value;
  const indefinite = indefiniteAdminKeyInput?.checked === true;
  const ttlHours = Number(ttlAdminKeyInput?.value || 24);
  try {
    const response = await authenticatedFetch(`${API_URL}/admin/access-keys`, {
      method: "POST",
      body: JSON.stringify({ role, ttlHours, indefinite })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Falha ao gerar chave");

    setMessage(
      mensagemGerarAdminKey,
      `Chave gerada (${adminLabel(data.role)}; expira: ${formatDate(data.expiresAt)}): ${data.accessKey}`,
      "lightgreen"
    );
    await loadAdminData();
  } catch (error) {
    setMessage(mensagemGerarAdminKey, error.message || "Erro ao gerar chave.", "red");
  }
});

async function initAdmin() {
  const user = await getUser();
  if (!user) {
    window.location.href = "/index.html";
    return;
  }
  currentUser = user;
  updateAdminState(currentUser);
  await refreshStatus();
  await loadAdminData();
}

initAdmin().catch((error) => {
  console.error("Erro ao inicializar painel admin:", error);
  setMessage(adminStatusBadge, "Erro ao verificar sessão", "red");
});
