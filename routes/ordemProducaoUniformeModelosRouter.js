// routes/ordemProducaoUniformeModelosRouter.js
import express from 'express';
import db from '../db.js';
import { r2DeleteObject } from './r2Client.js';

const router = express.Router();

/**
 * POST /ordens-uniformes/:ordemId/modelos
 * Cadastra um modelo (com detalhamentos_json JSONB).
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

  if (!ordemId) return res.status(400).json({ erro: 'ordemId é obrigatório.' });
  if (!modelo_id) return res.status(400).json({ erro: 'modelo_id é obrigatório.' });
  if (!tecido_id) return res.status(400).json({ erro: 'tecido_id é obrigatório.' });
  if (!gola_id)   return res.status(400).json({ erro: 'gola_id é obrigatório.' });
  if (!manga_id)  return res.status(400).json({ erro: 'manga_id é obrigatório.' });
  if (!referencia_layout || !referencia_layout.trim()) {
    return res.status(400).json({ erro: 'referencia_layout é obrigatório.' });
  }

  try {
    modelo_id = parseInt(modelo_id, 10);
    tecido_id = parseInt(tecido_id, 10);
    gola_id   = parseInt(gola_id, 10);
    manga_id  = parseInt(manga_id, 10);
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
 * Lista modelos da ordem com nomes (JOINs) e detalhamentos_json.
 */
router.get('/ordens-uniformes/:ordemId/modelos', async (req, res) => {
  const { ordemId } = req.params;
  try {
    const sql = `
      SELECT m.*,
             md.nome  AS modelo_nome,
             tec.nome AS tecido_nome,
             g.nome   AS gola_nome,
             man.nome AS manga_nome
        FROM ordem_producao_uniformes_dados_modelo m
   LEFT JOIN modelos    md  ON md.id  = m.modelo_id
   LEFT JOIN tecidos    tec ON tec.id = m.tecido_id
   LEFT JOIN tipo_gola  g   ON g.id   = m.gola_id
   LEFT JOIN tipo_manga man ON man.id = m.manga_id
       WHERE m.ordem_id = $1
    ORDER BY m.id ASC;
    `;
    const r = await db.query(sql, [ordemId]);
    res.json(r.rows);
  } catch (err) {
    console.error('Erro ao listar modelos:', err);
    res.status(500).json({ erro: 'Erro ao listar modelos.' });
  }
});

/**
 * GET /ordens-uniformes/modelos/:id
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
 * GET /ordens-uniformes/modelos/:id/tamanhos
 * Retorna os tamanhos/quantidades do item (modelo) já salvos.
 */
router.get('/ordens-uniformes/modelos/:id/tamanhos', async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT ti.id,
             ti.modelo_id,
             ti.tamanho_id,
             ti.quantidade,
             tg.tamanho AS nome_tamanho
        FROM ordem_producao_uniformes_tamanhos_item ti
   LEFT JOIN tamanhos_grade tg ON tg.id = ti.tamanho_id
       WHERE ti.modelo_id = $1
    ORDER BY tg.ordem_exibicao NULLS LAST, tg.tamanho;
    `;
    const { rows } = await db.query(sql, [id]);
    return res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar tamanhos do item:', err);
    return res.status(500).json({ erro: 'Erro ao buscar tamanhos do item.' });
  }
});

/**
 * POST /ordens-uniformes/modelos/:id/tamanhos/bulk
 * Substitui as quantidades do item pelos itens enviados.
 * Body: { itens: [{ tamanho_id:number, quantidade:number }, ...] }
 */
router.post('/ordens-uniformes/modelos/:id/tamanhos/bulk', async (req, res) => {
  const { id } = req.params;
  const { itens } = req.body || {};
  if (!Array.isArray(itens)) {
    return res.status(400).json({ erro: 'Envie itens como array.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // limpa tudo do item
    await client.query(
      'DELETE FROM ordem_producao_uniformes_tamanhos_item WHERE modelo_id = $1',
      [id]
    );

    // insere novamente apenas > 0
    for (const it of itens) {
      const tamanhoId = parseInt(it?.tamanho_id, 10);
      const qtd = parseInt(it?.quantidade, 10);
      if (!Number.isFinite(tamanhoId) || !Number.isFinite(qtd) || qtd <= 0) continue;

      await client.query(
        `INSERT INTO ordem_producao_uniformes_tamanhos_item
           (modelo_id, tamanho_id, quantidade)
         VALUES ($1, $2, $3)`,
        [id, tamanhoId, qtd]
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro no bulk de tamanhos:', err);
    return res.status(500).json({ erro: 'Erro ao salvar tamanhos.' });
  } finally {
    client.release();
  }
});

/**
 * PUT /ordens-uniformes/modelos/:id
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
 * Exclui arquivos do R2 (CDR, lista, preview), registros de arquivos e o item do modelo.
 *
 * Observações:
 * - Usa as colunas `item_id` e `key` na tabela `ordem_item_arquivo` (seu schema atual).
 * - O preview é lido do campo `preview_object_key` na própria tabela do item (se existir).
 */
router.delete('/ordens-uniformes/modelos/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // 1) Buscar ARQUIVOS (CDR, lista, etc.) vinculados a este item (schema atual)
    const { rows: arquivos } = await db.query(
      `SELECT id, key AS object_key
         FROM ordem_item_arquivo
        WHERE item_id = $1`,
      [id]
    );

    // 2) Buscar preview vinculado ao item (se a coluna existir)
    let previewKey = null;
    try {
      const { rows: prev } = await db.query(
        `SELECT preview_object_key
           FROM ordem_producao_uniformes_dados_modelo
          WHERE id = $1`,
        [id]
      );
      previewKey = prev[0]?.preview_object_key || null;
    } catch {
      previewKey = null;
    }

    // 3) Remover do R2 (tenta todos; se falhar algum, loga e segue)
    const chavesParaExcluir = [
      ...((arquivos || []).map(a => a?.object_key).filter(Boolean)),
      ...(previewKey ? [previewKey] : []),
    ];

    await Promise.all(
      chavesParaExcluir.map(async (key) => {
        try {
          await r2DeleteObject(key);
        } catch (e) {
          console.error('[DELETE item] Falha ao remover do R2:', key, e?.message || e);
        }
      })
    );

    // 4) Remover registros de arquivos desse item
    await db.query(`DELETE FROM ordem_item_arquivo WHERE item_id = $1`, [id]);

    // 5) Remover o item do modelo
    const r = await db.query(
      `DELETE FROM ordem_producao_uniformes_dados_modelo WHERE id = $1`,
      [id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    // 6) OK
    return res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir modelo (e arquivos):', err?.message || err);
    return res.status(500).json({ erro: 'Erro ao excluir modelo.' });
  }
});

export default router;
