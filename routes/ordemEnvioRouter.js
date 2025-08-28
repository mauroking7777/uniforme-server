// routes/ordemEnvioRouter.js
import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';

const router = express.Router();

let cacheTemColStatus = null;
async function temColunaStatus() {
  if (cacheTemColStatus !== null) return cacheTemColStatus;
  const sql = `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'ordem_setores'
       AND column_name  = 'status'
     LIMIT 1`;
  const r = await db.query(sql);
  cacheTemColStatus = r.rowCount > 0;
  return cacheTemColStatus;
}

async function ordemExiste(ordemId) {
  const q = await db.query(
    'SELECT 1 FROM public.ordem_producao_uniformes_dados_ordem WHERE id = $1 LIMIT 1',
    [ordemId]
  );
  return q.rowCount > 0;
}

/**
 * POST /ordens-uniformes/:id/enviar
 * Body: { slugs?: string[] }
 */
router.post('/ordens-uniformes/:id/enviar', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { slugs } = req.body || {};

    if (!(await ordemExiste(id))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    // valida itens e peças
    const q = await db.query(
      `
      SELECT
        COUNT(DISTINCT m.id)::int AS itens,
        COALESCE(SUM(t.quantidade), 0)::int AS pecas
      FROM public.ordem_producao_uniformes_dados_modelo m
      LEFT JOIN public.ordem_producao_uniformes_tamanhos_item t
        ON t.modelo_id = m.id
      WHERE m.ordem_id = $1
      `,
      [id]
    );
    const { itens, pecas } = q.rows[0] || { itens: 0, pecas: 0 };
    if (itens === 0 || pecas === 0) {
      return res.status(400).json({ erro: 'Inclua ao menos 1 item com quantidade para enviar.' });
    }

    await client.query('BEGIN');

    // sincroniza setores (se enviados)
    if (Array.isArray(slugs) && slugs.length > 0) {
      const rSet = await client.query(
        `SELECT id FROM public.setores WHERE slug = ANY($1::text[]) AND ativo = TRUE`,
        [slugs]
      );
      const ids = rSet.rows.map(r => r.id);
      if (ids.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Nenhum setor válido informado.' });
      }

      await client.query(
        `DELETE FROM public.ordem_setores
          WHERE ordem_id = $1
            AND setor_id NOT IN (SELECT unnest($2::int[]))`,
        [id, ids]
      );

      const colTemStatus = await temColunaStatus();
      for (const sid of ids) {
        if (colTemStatus) {
          await client.query(
            `INSERT INTO public.ordem_setores (ordem_id, setor_id, status)
             VALUES ($1, $2, 'aguardando')
             ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
            [id, sid]
          );
        } else {
          await client.query(
            `INSERT INTO public.ordem_setores (ordem_id, setor_id)
             VALUES ($1, $2)
             ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
            [id, sid]
          );
        }
      }
    }

    // marca OP como enviada
    await client.query(
      `UPDATE public.ordem_producao_uniformes_dados_ordem
          SET status = 'enviada'
        WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, id, status: 'enviada' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /ordens-uniformes/:id/enviar erro:', e);
    return res.status(500).json({ erro: 'Falha ao enviar ordem.' });
  } finally {
    client.release();
  }
});

export default router;
