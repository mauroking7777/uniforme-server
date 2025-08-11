import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * POST (1) — inserir UM tamanho
 * Body: { tamanho_id:number, quantidade:number }
 */
router.post('/ordens-uniformes/modelos/:modeloId/tamanhos', async (req, res) => {
  const { modeloId } = req.params;
  const { tamanho_id, quantidade } = req.body;

  if (!tamanho_id || quantidade === undefined) {
    return res.status(400).json({ erro: 'tamanho_id e quantidade são obrigatórios.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO ordem_producao_uniformes_tamanhos_item
         (modelo_id, tamanho_id, quantidade)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [Number(modeloId), Number(tamanho_id), Number(quantidade)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao adicionar tamanho.' });
  }
});

/**
 * POST (bulk) — inserir VÁRIOS tamanhos de uma vez
 * Body: { itens: [{ tamanho_id:number, quantidade:number }, ...] }
 */
router.post('/ordens-uniformes/modelos/:modeloId/tamanhos/bulk', async (req, res) => {
  const { modeloId } = req.params;
  const { itens } = req.body;

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos um item em "itens".' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sql = `
      INSERT INTO ordem_producao_uniformes_tamanhos_item
        (modelo_id, tamanho_id, quantidade)
      VALUES ($1, $2, $3)
    `;

    for (const it of itens) {
      const q = Number(it.quantidade) || 0;
      if (q <= 0) continue;
      await client.query(sql, [Number(modeloId), Number(it.tamanho_id), q]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar tamanhos (bulk):', err);
    res.status(500).json({ erro: 'Erro ao salvar tamanhos.' });
  } finally {
    client.release();
  }
});

/** GET — listar tamanhos do modelo */
router.get('/ordens-uniformes/modelos/:modeloId/tamanhos', async (req, res) => {
  const { modeloId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT ti.*, tg.tamanho AS nome_tamanho
         FROM ordem_producao_uniformes_tamanhos_item ti
         JOIN tamanhos_grade tg ON tg.id = ti.tamanho_id
        WHERE ti.modelo_id = $1
        ORDER BY tg.ordem_exibicao ASC`,
      [Number(modeloId)]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar tamanhos:', err);
    res.status(500).json({ erro: 'Erro ao listar tamanhos.' });
  }
});

/** PUT — atualizar um tamanho */
router.put('/ordens-uniformes/tamanhos/:id', async (req, res) => {
  const { id } = req.params;
  const { tamanho_id, quantidade } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE ordem_producao_uniformes_tamanhos_item
          SET tamanho_id = $1, quantidade = $2
        WHERE id = $3
        RETURNING *`,
      [Number(tamanho_id), Number(quantidade), Number(id)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tamanho.' });
  }
});

/** DELETE — excluir um tamanho */
router.delete('/ordens-uniformes/tamanhos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(
      'DELETE FROM ordem_producao_uniformes_tamanhos_item WHERE id = $1',
      [Number(id)]
    );
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir tamanho:', err);
    res.status(500).json({ erro: 'Erro ao excluir tamanho.' });
  }
});

export default router;
