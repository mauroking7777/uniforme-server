import express from 'express';
import db from '../db.js';

const router = express.Router();

// Criar nova ordem de produção de uniformes
router.post('/ordens-uniformes', async (req, res) => {
  const { numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, usuario_id } = req.body;

  if (!numero_ordem || !data_entrada || !prazo_entrega || !data_entrega || !cliente || !usuario_id) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    const nova = await db.query(
      `INSERT INTO ordem_producao_uniformes_dados_ordem
      (numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, status, usuario_id)
      VALUES ($1, $2, $3, $4, $5, 'rascunho', $6)
      RETURNING *`,
      [numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, usuario_id]
    );
    res.status(201).json(nova.rows[0]);
  } catch (err) {
    console.error('Erro ao criar ordem:', err);
    res.status(500).json({ erro: 'Erro ao criar ordem.' });
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
    console.error('Erro ao listar ordens:', err);
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
    console.error('Erro ao buscar ordem:', err);
    res.status(500).json({ erro: 'Erro ao buscar ordem.' });
  }
});

// Atualizar ordem (auto salvamento)
router.put('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  const { numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, status, usuario_id } = req.body;

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
      [numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, status, usuario_id, id]
    );

    res.json(atualizada.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar ordem:', err);
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
    console.error('Erro ao excluir ordem:', err);
    res.status(500).json({ erro: 'Erro ao excluir ordem.' });
  }
});

export default router;
