// routes/ordemProducaoUniformeSetoresRouter.js
import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';

const router = express.Router();

/**
 * Confere se a ordem existe
 */
async function ordemExiste(ordemId) {
  const q = await db.query(
    'SELECT 1 FROM public.ordem_producao_uniformes_dados_ordem WHERE id = $1 LIMIT 1',
    [ordemId]
  );
  return q.rowCount > 0;
}

/**
 * Resolve lista de IDs de setores a partir de slugs
 */
async function resolverSetorIdsPorSlugs(slugs = []) {
  if (!Array.isArray(slugs) || slugs.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id
       FROM public.setores
      WHERE slug = ANY($1::text[])`,
    [slugs]
  );
  return rows.map(r => r.id);
}

/**
 * GET: lista os setores vinculados a uma ordem
 * (devolve nome/slug/status para o front exibir as seleções)
 * Obs.: deixei sem requireAuth para não quebrar telas que já consomem sem token;
 * se quiser fechar, basta adicionar requireAuth como middleware.
 */
router.get('/ordens-uniformes/:ordemId/setores', async (req, res) => {
  try {
    const { ordemId } = req.params;

    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    const { rows } = await db.query(
      `SELECT os.ordem_id,
              os.setor_id,
              os.status,
              os.recebida_em,
              os.iniciada_em,
              os.concluida_em,
              os.prioridade,
              s.nome,
              s.slug
         FROM public.ordem_setores os
         JOIN public.setores s
           ON s.id = os.setor_id
        WHERE os.ordem_id = $1
        ORDER BY s.ordem_exibicao NULLS LAST, s.nome`,
      [ordemId]
    );

    return res.json(rows);
  } catch (e) {
    console.error('GET setores da ordem erro:', e);
    return res.status(500).json({ erro: 'Falha ao buscar setores da ordem.' });
  }
});

/**
 * POST: sincroniza setores vinculados à ordem (adiciona os faltantes e remove os que não estiverem mais na lista)
 * Requer auth. Aceita body com { setor_ids?: number[], slugs?: string[] }.
 * Regras:
 *  - Vínculos novos nascem com status = 'aguardando'
 *  - Backfill: vínculos existentes com status NULL são atualizados para 'aguardando'
 */
router.post('/ordens-uniformes/:ordemId/setores', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { ordemId } = req.params;
    let { setor_ids: setorIds, slugs } = req.body || {};

    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    // Normaliza lista de IDs
    let ids = Array.isArray(setorIds) ? setorIds.filter(n => Number.isFinite(n * 1)).map(n => Number(n)) : [];

    // Se vieram slugs, resolve para ids
    if ((!ids || ids.length === 0) && Array.isArray(slugs) && slugs.length > 0) {
      ids = await resolverSetorIdsPorSlugs(slugs);
    }

    // Se continuar vazio, não há o que vincular
    if (!ids || ids.length === 0) {
      // Permito "zerar" vínculos: apago todos.
      await client.query('BEGIN');
      await client.query('DELETE FROM public.ordem_setores WHERE ordem_id = $1', [ordemId]);
      await client.query('COMMIT');

      return res.json({ ok: true, setores: [] });
    }

    // Traz vínculos atuais
    const { rows: atuais } = await db.query(
      `SELECT setor_id FROM public.ordem_setores WHERE ordem_id = $1`,
      [ordemId]
    );
    const atuaisSet = new Set(atuais.map(r => Number(r.setor_id)));

    const novos = ids.filter(id => !atuaisSet.has(Number(id)));
    const manter = ids.filter(id => atuaisSet.has(Number(id)));

    await client.query('BEGIN');

    // Remove os que não estão mais na lista enviada
    await client.query(
      `DELETE FROM public.ordem_setores
        WHERE ordem_id = $1
          AND setor_id NOT IN (SELECT unnest($2::int[]))`,
      [ordemId, ids]
    );

    // Insere os novos com status 'aguardando'
    if (novos.length > 0) {
      for (const sid of novos) {
        await client.query(
          `INSERT INTO public.ordem_setores (ordem_id, setor_id, status, recebida_em)
           VALUES ($1, $2, 'aguardando', NOW())
           ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
          [ordemId, sid]
        );
      }
    }

    // Backfill de segurança: se houver vínculos (antigos ou mantidos) com status NULL, corrige para 'aguardando'
    if (manter.length > 0) {
      await client.query(
        `UPDATE public.ordem_setores
            SET status = 'aguardando'
          WHERE ordem_id = $1
            AND setor_id = ANY($2::int[])
            AND status IS NULL`,
        [ordemId, manter]
      );
    }

    await client.query('COMMIT');

    // Retorna visão atualizada (join com setores, ordenado)
    const { rows } = await db.query(
      `SELECT os.ordem_id,
              os.setor_id,
              os.status,
              os.recebida_em,
              os.iniciada_em,
              os.concluida_em,
              os.prioridade,
              s.nome,
              s.slug
         FROM public.ordem_setores os
         JOIN public.setores s
           ON s.id = os.setor_id
        WHERE os.ordem_id = $1
        ORDER BY s.ordem_exibicao NULLS LAST, s.nome`,
      [ordemId]
    );

    return res.json({ ok: true, setores: rows });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST setores da ordem erro:', e);
    return res.status(500).json({ erro: 'Falha ao salvar setores da ordem.' });
  } finally {
    client.release();
  }
});

export default router;
