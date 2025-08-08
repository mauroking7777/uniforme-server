import express from 'express';
import db from '../db.js';

const router = express.Router();

// Adicionar novo modelo à ordem
router.post('/ordens-uniformes/:ordemId/modelos', async (req, res) => {
  const { ordemId } = req.params;
  const {
    modelo_id,
    tecido_id,
    cor_ribana,
    gola_id,
    manga_id,
    detalhe_manga_id,
    referencia_layout,
    informacoes_adicionais
  } = req.body;

  if (!modelo_id || !tecido_id || !referencia_layout) {
    return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  }

  try {
    const novoModelo = await db.query(
      `INSERT INTO ordem_producao_uniformes_dados_modelo
      (ordem_id, modelo_id, tecido_id, cor_ribana, gola_id, manga_id, detalhe_manga_id, referencia_layout, informacoes_adicionais)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        ordemId,
        modelo_id,
        tecido_id,
        cor_ribana,
        gola_id,
        manga_id,
        detalhe_manga_id,
        referencia_layout.toUpperCase(),
        informacoes_adicionais
      ]
    );
    res.status(201).json(novoModelo.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar modelo:', err);
    res.status(500).json({ erro: 'Erro ao adicionar modelo.' });
  }
});

// Listar modelos de uma ordem
router.get('/ordens-uniformes/:ordemId/modelos', async (req, res) => {
  const { ordemId } = req.params;
  try {
    const resultado = await db.query(
      `SELECT * FROM ordem_producao_uniformes_dados_modelo WHERE ordem_id = $1 ORDER BY id ASC`,
      [ordemId]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error('Erro ao listar modelos:', err);
    res.status(500).json({ erro: 'Erro ao listar modelos.' });
  }
});

// Atualizar modelo
router.put('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;
  const {
    modelo_id,
    tecido_id,
    cor_ribana,
    gola_id,
    manga_id,
    detalhe_manga_id,
    referencia_layout,
    informacoes_adicionais
  } = req.body;

  try {
    const atualizado = await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
       SET modelo_id = $1,
           tecido_id = $2,
           cor_ribana = $3,
           gola_id = $4,
           manga_id = $5,
           detalhe_manga_id = $6,
           referencia_layout = $7,
           informacoes_adicionais = $8
       WHERE id = $9
       RETURNING *`,
      [
        modelo_id,
        tecido_id,
        cor_ribana,
        gola_id,
        manga_id,
        detalhe_manga_id,
        referencia_layout.toUpperCase(),
        informacoes_adicionais,
        id
      ]
    );
    res.json(atualizado.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar modelo:', err);
    res.status(500).json({ erro: 'Erro ao atualizar modelo.' });
  }
});

// Excluir modelo da ordem
router.delete('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(
      'DELETE FROM ordem_producao_uniformes_dados_modelo WHERE id = $1',
      [id]
    );
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir modelo:', err);
    res.status(500).json({ erro: 'Erro ao excluir modelo.' });
  }
});

export default router;
