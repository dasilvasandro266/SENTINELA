const jwt = require('jsonwebtoken');
const { query: pgQuery } = require('../postgres');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET não definido em user-service. Configure para produção.');
}

const ADMIN_CAPABILITIES = {
  CONTENT: 'content.manage',
  ADMINS: 'admins.manage'
};

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizarAdminRole(role) {
  const clean = String(role || '').trim().toLowerCase();
  if (clean === 'bootstrap') return 'bootstrap';
  if (clean === 'content') return 'content';
  return 'general';
}

function capacidadesPorRole(role) {
  const normalized = normalizarAdminRole(role);
  if (normalized === 'content') return [ADMIN_CAPABILITIES.CONTENT];
  return [ADMIN_CAPABILITIES.CONTENT, ADMIN_CAPABILITIES.ADMINS];
}

function normalizarCapacidades(role, rawCapabilities) {
  const allowed = new Set(capacidadesPorRole(role));
  const requested = parseJsonArray(rawCapabilities)
    .map((item) => String(item || '').trim())
    .filter((item) => allowed.has(item));
  return requested.length ? [...new Set(requested)] : [...allowed];
}

function isAdminAtivo(row) {
  if (!row || row.is_admin !== true) return false;
  if (row.admin_revoked_at) return false;
  if (row.admin_expires_at && new Date(row.admin_expires_at).getTime() <= Date.now()) return false;
  return true;
}

function adminProfileFromRow(row) {
  if (!isAdminAtivo(row)) {
    return {
      active: false,
      role: null,
      capabilities: [],
      promotedBy: row?.admin_promoted_by || null,
      expiresAt: row?.admin_expires_at || null,
      revokedAt: row?.admin_revoked_at || null
    };
  }
  const role = normalizarAdminRole(row.admin_role || 'general');
  return {
    active: true,
    role,
    capabilities: normalizarCapacidades(role, row.admin_capabilities),
    promotedBy: row.admin_promoted_by || null,
    expiresAt: row.admin_expires_at || null,
    revokedAt: null
  };
}

function mapPgUser(row) {
  if (!row) return null;

  const admin = adminProfileFromRow(row);
  return {
    id: row.id,
    userId: row.id,
    email: row.email,
    username: row.username,
    nome_completo: row.nome_completo || '',
    instituicao: row.instituicao || '',
    nivel_academico: row.nivel_academico || '',
    isAdmin: admin.active,
    adminRole: admin.role,
    adminCapabilities: admin.capabilities,
    adminPromotedBy: admin.promotedBy,
    adminExpiresAt: admin.expiresAt,
    adminRevokedAt: admin.revokedAt
  };
}

function gerarTokenUsuario(user) {
  const admin = adminProfileFromRow(user);
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      username: user.username,
      isAdmin: admin.active,
      adminRole: admin.role,
      adminCapabilities: admin.capabilities
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function normalizarNomeUsuario(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

async function buscarUsuarioPorId(userId) {
  const { rows } = await pgQuery(
    `SELECT id, email, username, nome_completo, instituicao, nivel_academico, is_admin,
            admin_role, admin_capabilities, admin_promoted_by, admin_expires_at, admin_revoked_at, created_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function buscarUsuarioPorEmail(email) {
  const { rows } = await pgQuery('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  return rows[0] || null;
}

async function buscarUsuarioPorUsernameNormalizado(usernameNormalized) {
  const { rows } = await pgQuery('SELECT * FROM users WHERE username_normalized = $1 LIMIT 1', [usernameNormalized]);
  return rows[0] || null;
}

module.exports = {
  ADMIN_CAPABILITIES,
  buscarUsuarioPorId,
  buscarUsuarioPorEmail,
  buscarUsuarioPorUsernameNormalizado,
  mapPgUser,
  gerarTokenUsuario,
  normalizarNomeUsuario,
  normalizarAdminRole,
  normalizarCapacidades,
  isAdminAtivo,
  adminProfileFromRow
};
