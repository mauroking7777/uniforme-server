import express from 'express';
import db from '../db.js';

const router = express.Router();

// Adicionar tamanho ao modelo da ordem
router.post('/ordens-uniformes/modelos/:modeloId/tamanhos', async (req, res) => {
  const { modeloId } = req.params;
  const { tamanho_grade_id, quantidade } = req.body;

  if (!tamanho_grade_id || quantidade === undefined) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    const novo = await db.query(
      `INSERT INTO ordem_producao_uniformes_tamanhos_item
       (modelo_item_id, tamanho_grade_id, quantidade)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [modeloId, tamanho_grade_id, quantidade]
    );
    res.status(201).json(novo.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao adicionar tamanho.' });
  }
});

// Listar tamanhos de um modelo
router.get('/ordens-uniformes/modelos/:modeloId/tamanhos', async (req, res) => {
  const { modeloId } = req.params;

  try {
    const resultado = await db.query(
      `SELECT ti.*, tg.nome AS nome_tamanho
       FROM ordem_producao_uniformes_tamanhos_item ti
       JOIN tamanhos_grade tg ON tg.id = ti.tamanho_grade_id
       WHERE modelo_item_id = $1
       ORDER BY tg.nome`,
      [modeloId]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error('Erro ao listar tamanhos:', err);
    res.status(500).json({ erro: 'Erro ao buscar tamanhos.' });
  }
});

// Atualizar tamanho
router.put('/ordens-uniformes/tamanhos/:id', async (req, res) => {
  const { id } = req.params;
  const { tamanho_grade_id, quantidade } = req.body;

  try {
    const atualizado = await db.query(
      `UPDATE ordem_producao_uniformes_tamanhos_item
       SET tamanho_grade_id = $1,
           quantidade = $2
       WHERE id = $3
       RETURNING *`,
      [tamanho_grade_id, quantidade, id]
    );
    res.json(atualizado.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tamanho.' });
  }
});

// Excluir um tamanho
router.delete('/ordens-uniformes/tamanhos/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('DELETE FROM ordem_producao_uniformes_tamanhos_item WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir tamanho:', err);
    res.status(500).json({ erro: 'Erro ao excluir tamanho.' });
  }
});

export default router;
