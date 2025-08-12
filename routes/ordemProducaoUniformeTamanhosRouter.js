// src/routes/ordensUniformesTamanhos.routes.js (ou equivalente)
import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * POST — inserir UM tamanho para um modelo
 * Body: { tamanho_id:number, quantidade:number }
 * Regra: o modelo só pode ter tamanhos de UMA única grade.
 */
router.post('/ordens-uniformes/modelos/:modeloId/tamanhos', async (req, res) => {
  const { modeloId } = req.params;
  const { tamanho_id, quantidade } = req.body;

  if (!tamanho_id || quantidade === undefined) {
    return res.status(400).json({ erro: 'tamanho_id e quantidade são obrigatórios.' });
  }

  try {
    // 1) Descobre a grade do tamanho enviado
    const rNovo = await db.query(
      'SELECT grade_id FROM tamanhos_grade WHERE id = $1',
      [Number(tamanho_id)]
    );
    if (rNovo.rowCount === 0) {
      return res.status(400).json({ erro: 'tamanho_id inválido.' });
    }
    const gradeNova = rNovo.rows[0].grade_id;

    // 2) Verifica grades já existentes no modelo
    const rExist = await db.query(
      `SELECT DISTINCT tg.grade_id
         FROM ordem_producao_uniformes_tamanhos_item ti
         JOIN tamanhos_grade tg ON tg.id = ti.tamanho_id
        WHERE ti.modelo_id = $1`,
      [Number(modeloId)]
    );

    if (rExist.rowCount > 0) {
      const gradesExistentes = new Set(rExist.rows.map(r => r.grade_id));
      // Se já existe grade e for diferente da nova, barra
      if (gradesExistentes.size > 1 || !gradesExistentes.has(gradeNova)) {
        return res.status(400).json({ erro: 'Use apenas uma grade por modelo.' });
      }
    }

    // 3) OK, insere
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
 * Regra: todos os tamanhos do payload devem ser da MESMA grade e,
 * se o modelo já possuir tamanhos, devem pertencer à MESMA grade existente.
 */
router.post('/ordens-uniformes/modelos/:modeloId/tamanhos/bulk', async (req, res) => {
  const { modeloId } = req.params;
  const { itens } = req.body;

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos um item em "itens".' });
  }

  // Coleta e valida tamanho_ids
  const tamanhoIds = itens.map(i => Number(i.tamanho_id));
  if (tamanhoIds.some(id => !Number.isFinite(id))) {
    return res.status(400).json({ erro: 'Payload inválido: tamanho_id ausente/inválido.' });
  }

  const client = await db.connect();
  try {
    // 1) Grade dos tamanhos enviados
    const rTams = await client.query(
      `SELECT id AS tamanho_id, grade_id
         FROM tamanhos_grade
        WHERE id = ANY($1)`,
      [tamanhoIds]
    );
    if (rTams.rowCount !== tamanhoIds.length) {
      return res.status(400).json({ erro: 'Alguns tamanhos não existem.' });
    }

    const gradesNoPayload = new Set(rTams.rows.map(r => r.grade_id));
    if (gradesNoPayload.size > 1) {
      return res.status(400).json({ erro: 'Use apenas uma grade por modelo.' });
    }
    const gradeDoPayload = rTams.rows[0].grade_id;

    // 2) Grade já existente para o modelo (se houver)
    const rExist = await client.query(
      `SELECT DISTINCT tg.grade_id
         FROM ordem_producao_uniformes_tamanhos_item ti
         JOIN tamanhos_grade tg ON tg.id = ti.tamanho_id
        WHERE ti.modelo_id = $1`,
      [Number(modeloId)]
    );
    if (rExist.rowCount > 0) {
      const gradesExistentes = new Set(rExist.rows.map(r => r.grade_id));
      if (gradesExistentes.size > 1 || !gradesExistentes.has(gradeDoPayload)) {
        return res.status(400).json({ erro: 'Use apenas uma grade por modelo.' });
      }
    }

    // 3) Inserção dos tamanhos
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

/** GET — listar tamanhos de um modelo */
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
