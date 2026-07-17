const express = require('express');
const { authenticateToken } = require('../auth');
const { buscarUsuarioPorId, mapPgUser } = require('../services/user-service');
const { query: pgQuery } = require('../postgres');

const router = express.Router();
router.use(authenticateToken);

router.get('/me', async (req, res) => {
  try {
    const userRow = await buscarUsuarioPorId(req.user.userId);
    if (!userRow) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json(mapPgUser(userRow));
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  if (req.user.userId !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  try {
    const userRow = await buscarUsuarioPorId(userId);
    if (!userRow) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json(mapPgUser(userRow));
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

router.patch('/me', async (req, res) => {
  const { nomeCompleto, instituicao } = req.body;
  try {
    const { rows } = await pgQuery(
      `UPDATE users
       SET nome_completo = COALESCE($1, nome_completo),
           instituicao = COALESCE($2, instituicao),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, username, nome_completo, instituicao, nivel_academico, is_admin`,
      [
        nomeCompleto !== undefined ? String(nomeCompleto) : null,
        instituicao !== undefined ? String(instituicao) : null,
        req.user.userId
      ]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json({ success: true, user: mapPgUser(rows[0]) });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

router.delete('/me', async (req, res) => {
  try {
    await pgQuery('DELETE FROM users WHERE id = $1', [req.user.userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao eliminar conta:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

module.exports = router;
