import express from 'express';
import db from '../db.js';

const router = express.Router();

// Criar nova ordem de produção de uniformes
router.post('/ordens-uniformes', async (req, res) => {
  const {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    usuario_id,
    tipo_ordem // ✅ novo campo adicionado aqui
  } = req.body;

  // Validação básica
  if (
    !numero_ordem ||
    !data_entrada ||
    !prazo_entrega ||
    !data_entrega ||
    !cliente ||
    !usuario_id ||
    !tipo_ordem // ✅ também obrigatório
  ) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    const nova = await db.query(
      `INSERT INTO ordem_producao_uniformes_dados_ordem
        (numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, status, usuario_id, tipo_ordem)
       VALUES ($1, $2, $3, $4, $5, 'rascunho', $6, $7)
       RETURNING *`,
      [numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, usuario_id, tipo_ordem]
    );

    res.status(201).json(nova.rows[0]);
  } catch (err) {
    res.status(500).json({
      erro: 'Erro ao criar ordem.',
      detalhes: err.message,
      dadosRecebidos: {
        numero_ordem,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        usuario_id,
        tipo_ordem
      }
    });
  }
});


// Listar todas as ordens
router.get('/ordens-uniformes', async (req, res) => {
  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem ORDER BY id DESC'
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordens.' });
  }
});

// Buscar uma ordem por ID
router.get('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem WHERE id = $1',
      [id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }
    res.json(resultado.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordem.' });
  }
});

// Atualizar ordem (auto salvamento)
router.put('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  const {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    status,
    usuario_id,
  } = req.body;

  try {
    const atualizada = await db.query(
      `UPDATE ordem_producao_uniformes_dados_ordem
       SET numero_ordem = $1,
           data_entrada = $2,
           prazo_entrega = $3,
           data_entrega = $4,
           cliente = $5,
           status = $6,
           usuario_id = $7
       WHERE id = $8
       RETURNING *`,
      [
        numero_ordem,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        status,
        usuario_id,
        id,
      ]
    );

    res.json(atualizada.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar ordem.' });
  }
});

// Excluir ordem (se necessário)
router.delete('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM ordem_producao_uniformes_dados_ordem WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir ordem.' });
  }
});

// Listar todas as ordens de um usuário específico
router.get('/ordens-uniformes/usuario/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem WHERE usuario_id = $1 ORDER BY id DESC',
      [id]
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordens do usuário.' });
  }
});

// Buscar todas as ordens de um usuário específico
router.get('/ordens-uniformes/usuario/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;

  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem WHERE usuario_id = $1 ORDER BY id DESC',
      [usuario_id]
    );

    res.json(resultado.rows);
  } catch (err) {
    console.error('Erro ao buscar ordens do usuário:', err);
    res.status(500).json({ erro: 'Erro ao buscar ordens do usuário.' });
  }
});



export default router;
