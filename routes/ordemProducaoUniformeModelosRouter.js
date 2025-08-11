import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * POST /ordens-uniformes/:ordemId/modelos
 * Cadastra um modelo dentro da ordem, incluindo detalhamentos_json (JSONB).
 */
router.post('/ordens-uniformes/:ordemId/modelos', async (req, res) => {
  const { ordemId } = req.params;
  let {
    modelo_id,
    tecido_id,
    cor_ribana = null,
    gola_id,
    manga_id,
    detalhe_manga_id = null,
    referencia_layout,
    informacoes_adicionais = null,
    detalhamentos_json = [],
  } = req.body;

  // Validações básicas
  if (!ordemId) return res.status(400).json({ erro: 'ordemId é obrigatório.' });
  if (!modelo_id) return res.status(400).json({ erro: 'modelo_id é obrigatório.' });
  if (!tecido_id) return res.status(400).json({ erro: 'tecido_id é obrigatório.' });
  if (!gola_id)   return res.status(400).json({ erro: 'gola_id é obrigatório.' });
  if (!manga_id)  return res.status(400).json({ erro: 'manga_id é obrigatório.' });
  if (!referencia_layout || !referencia_layout.trim()) {
    return res.status(400).json({ erro: 'referencia_layout é obrigatório.' });
  }

  // Normalizações
  try {
    modelo_id  = parseInt(modelo_id, 10);
    tecido_id  = parseInt(tecido_id, 10);
    gola_id    = parseInt(gola_id, 10);
    manga_id   = parseInt(manga_id, 10);
    if (detalhe_manga_id !== null && detalhe_manga_id !== undefined && detalhe_manga_id !== '') {
      detalhe_manga_id = parseInt(detalhe_manga_id, 10);
      if (Number.isNaN(detalhe_manga_id)) detalhe_manga_id = null;
    } else {
      detalhe_manga_id = null;
    }
  } catch {
    return res.status(400).json({ erro: 'IDs inválidos (modelo/tecido/gola/manga).' });
  }

  // Garante array JSON válido
  if (!Array.isArray(detalhamentos_json)) {
    try {
      detalhamentos_json = JSON.parse(detalhamentos_json);
      if (!Array.isArray(detalhamentos_json)) detalhamentos_json = [];
    } catch {
      detalhamentos_json = [];
    }
  }

  try {
    const sql = `
      INSERT INTO ordem_producao_uniformes_dados_modelo
        (ordem_id, modelo_id, tecido_id, cor_ribana, gola_id, manga_id, detalhe_manga_id,
         referencia_layout, informacoes_adicionais, detalhamentos_json)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10::jsonb)
      RETURNING *;
    `;
    const params = [
      ordemId,
      modelo_id,
      tecido_id,
      cor_ribana,
      gola_id,
      manga_id,
      detalhe_manga_id,
      referencia_layout.toUpperCase(),
      informacoes_adicionais,
      JSON.stringify(detalhamentos_json),
    ];

    const result = await db.query(sql, params);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar modelo:', err);
    return res.status(500).json({ erro: 'Erro ao adicionar modelo.' });
  }
});

/**
 * GET /ordens-uniformes/:ordemId/modelos
 * Lista os modelos de uma ordem (inclui detalhamentos_json).
 */
router.get('/ordens-uniformes/:ordemId/modelos', async (req, res) => {
  const { ordemId } = req.params;
  try {
    const r = await db.query(
      `SELECT *
         FROM ordem_producao_uniformes_dados_modelo
        WHERE ordem_id = $1
        ORDER BY id ASC`,
      [ordemId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Erro ao listar modelos:', err);
    res.status(500).json({ erro: 'Erro ao listar modelos.' });
  }
});

/**
 * GET /ordens-uniformes/modelos/:id
 * Busca um modelo específico pelo ID.
 */
router.get('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query(
      `SELECT * FROM ordem_producao_uniformes_dados_modelo WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Erro ao buscar modelo:', err);
    res.status(500).json({ erro: 'Erro ao buscar modelo.' });
  }
});

/**
 * PUT /ordens-uniformes/modelos/:id
 * Atualiza um modelo da ordem (inclui detalhamentos_json).
 */
router.put('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;
  let {
    modelo_id,
    tecido_id,
    cor_ribana = null,
    gola_id,
    manga_id,
    detalhe_manga_id = null,
    referencia_layout,
    informacoes_adicionais = null,
    detalhamentos_json = [],
  } = req.body;

  if (!referencia_layout || !referencia_layout.trim()) {
    return res.status(400).json({ erro: 'referencia_layout é obrigatório.' });
  }

  try {
    if (modelo_id !== undefined) modelo_id = parseInt(modelo_id, 10);
    if (tecido_id !== undefined) tecido_id = parseInt(tecido_id, 10);
    if (gola_id   !== undefined) gola_id   = parseInt(gola_id, 10);
    if (manga_id  !== undefined) manga_id  = parseInt(manga_id, 10);
    if (detalhe_manga_id !== null && detalhe_manga_id !== undefined && detalhe_manga_id !== '') {
      detalhe_manga_id = parseInt(detalhe_manga_id, 10);
      if (Number.isNaN(detalhe_manga_id)) detalhe_manga_id = null;
    } else {
      detalhe_manga_id = null;
    }
  } catch {
    return res.status(400).json({ erro: 'IDs inválidos (modelo/tecido/gola/manga).' });
  }

  if (!Array.isArray(detalhamentos_json)) {
    try {
      detalhamentos_json = JSON.parse(detalhamentos_json);
      if (!Array.isArray(detalhamentos_json)) detalhamentos_json = [];
    } catch {
      detalhamentos_json = [];
    }
  }

  try {
    const sql = `
      UPDATE ordem_producao_uniformes_dados_modelo
         SET modelo_id = COALESCE($1, modelo_id),
             tecido_id = COALESCE($2, tecido_id),
             cor_ribana = $3,
             gola_id = COALESCE($4, gola_id),
             manga_id = COALESCE($5, manga_id),
             detalhe_manga_id = $6,
             referencia_layout = $7,
             informacoes_adicionais = $8,
             detalhamentos_json = $9::jsonb
       WHERE id = $10
       RETURNING *;
    `;
    const params = [
      modelo_id ?? null,
      tecido_id ?? null,
      cor_ribana,
      gola_id ?? null,
      manga_id ?? null,
      detalhe_manga_id,
      referencia_layout.toUpperCase(),
      informacoes_adicionais,
      JSON.stringify(detalhamentos_json),
      id,
    ];

    const r = await db.query(sql, params);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar modelo:', err);
    res.status(500).json({ erro: 'Erro ao atualizar modelo.' });
  }
});

/**
 * DELETE /ordens-uniformes/modelos/:id
 * Exclui um modelo da ordem.
 */
router.delete('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query(
      'DELETE FROM ordem_producao_uniformes_dados_modelo WHERE id = $1',
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir modelo:', err);
    res.status(500).json({ erro: 'Erro ao excluir modelo.' });
  }
});

export default router;
