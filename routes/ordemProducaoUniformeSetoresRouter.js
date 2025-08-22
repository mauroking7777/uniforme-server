// routes/ordemProducaoUniformeSetoresRouter.js
import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';

const router = express.Router();

/**
 * Util: checa se a ordem existe
 */
async function ordemExiste(ordemId) {
  const q = await db.query(
    'SELECT 1 FROM public.ordem_producao_uniformes_dados_ordem WHERE id = $1 LIMIT 1',
    [ordemId]
  );
  return q.rowCount > 0;
}

/**
 * GET /ordens-uniformes/:ordemId/setores
 * -> setores atualmente marcados nessa ordem
 * Retorna: [{ id, slug, nome }]
 */
router.get('/ordens-uniformes/:ordemId/setores', async (req, res) => {
  try {
    const { ordemId } = req.params;

    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    const { rows } = await db.query(
      `
      SELECT s.id, s.slug, s.nome
      FROM public.ordem_setores os
      JOIN public.setores s ON s.id = os.setor_id
      WHERE os.ordem_id = $1
      ORDER BY s.ordem_exibicao NULLS LAST, s.nome ASC
      `,
      [ordemId]
    );

    res.json(rows);
  } catch (e) {
    console.error('GET setores da ordem erro:', e);
    res.status(500).json({ erro: 'Falha ao listar setores da ordem.' });
  }
});

/**
 * POST /ordens-uniformes/:ordemId/setores
 * Sincroniza os setores da ordem.
 * Aceita:
 *   - { setor_ids: number[] }   OU
 *   - { slugs: string[] }       (ex.: ["sublimacao","serigrafia","bordado"])
 *
 * Regra: precisa ter ao menos 1 setor.
 */
router.post('/ordens-uniformes/:ordemId/setores', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { ordemId } = req.params;
    const { setor_ids, slugs } = req.body || {};

    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    // Resolve ids a partir dos slugs, se necessário
    let ids = Array.isArray(setor_ids) ? setor_ids.filter(Number.isFinite) : [];

    if ((!ids || ids.length === 0) && Array.isArray(slugs) && slugs.length > 0) {
      const q = await db.query(
        `SELECT id FROM public.setores WHERE slug = ANY($1::text[]) AND ativo = TRUE`,
        [slugs]
      );
      ids = q.rows.map(r => r.id);
    }

    if (!ids || ids.length === 0) {
      return res.status(400).json({ erro: 'Selecione ao menos um setor.' });
    }

    await client.query('BEGIN');

    // Remove o que não está mais selecionado
    await client.query(
      `DELETE FROM public.ordem_setores
        WHERE ordem_id = $1
          AND NOT (setor_id = ANY($2::int[]))`,
      [ordemId, ids]
    );

    // Adiciona os que faltam (idempotente pelo UNIQUE(ordem_id,setor_id))
    for (const sid of ids) {
      await client.query(
        `INSERT INTO public.ordem_setores (ordem_id, setor_id)
         VALUES ($1, $2)
         ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
        [ordemId, sid]
      );
    }

    await client.query('COMMIT');

    // Retorna a fotografia atual
    const { rows } = await db.query(
      `SELECT s.id, s.slug, s.nome
         FROM public.ordem_setores os
         JOIN public.setores s ON s.id = os.setor_id
        WHERE os.ordem_id = $1
        ORDER BY s.ordem_exibicao NULLS LAST, s.nome ASC`,
      [ordemId]
    );

    res.json({ ok: true, setores: rows });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST setores da ordem erro:', e);
    res.status(500).json({ erro: 'Falha ao salvar setores da ordem.' });
  } finally {
    client.release();
  }
});

export default router;
