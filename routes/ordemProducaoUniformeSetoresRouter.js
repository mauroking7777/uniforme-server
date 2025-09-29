// routes/ordemProducaoUniformeSetoresRouter.js
import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';

const router = express.Router();

/** Confere se a ordem existe */
async function ordemExiste(ordemId) {
  const q = await db.query(
    'SELECT 1 FROM public.ordem_producao_uniformes_dados_ordem WHERE id = $1 LIMIT 1',
    [ordemId]
  );
  return q.rowCount > 0;
}

/** Descobre se a tabela ordem_setores tem a coluna "status" (cache em memória) */
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

/** Resolve lista de IDs de setores a partir de slugs */
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

/** GET: lista setores vinculados (apenas o necessário pro front) */
router.get('/ordens-uniformes/:ordemId/setores', async (req, res) => {
  try {
    const { ordemId } = req.params;

    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    const { rows } = await db.query(
      `SELECT s.id, s.slug, s.nome
         FROM public.ordem_setores os
         JOIN public.setores s ON s.id = os.setor_id
        WHERE os.ordem_id = $1
        ORDER BY s.ordem_exibicao NULLS LAST, s.nome`,
      [ordemId]
    );

    return res.json(rows);
  } catch (e) {
    console.error('GET /ordens-uniformes/:ordemId/setores erro:', e);
    return res.status(500).json({ erro: 'Falha ao buscar setores da ordem.' });
  }
});

/** POST: sincroniza setores da ordem (add faltantes, remove não selecionados) */
router.post('/ordens-uniformes/:ordemId/setores', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { ordemId } = req.params;
    let { setor_ids: setorIds, slugs } = req.body || {};
    // garante que, se o front marcar 'sublimacao', também salvaremos 'configuracao'
if (Array.isArray(slugs)) {
  const norm = slugs.map(s => String(s).toLowerCase());
  if (norm.includes('sublimacao') && !norm.includes('configuracao')) {
    slugs = [...slugs, 'configuracao'];
  }
}


    if (!(await ordemExiste(ordemId))) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    // Normaliza IDs
    let ids = Array.isArray(setorIds)
      ? setorIds.filter(n => Number.isFinite(n * 1)).map(n => Number(n))
      : [];

    // Resolve por slugs, se necessário
    if ((!ids || ids.length === 0) && Array.isArray(slugs) && slugs.length > 0) {
      ids = await resolverSetorIdsPorSlugs(slugs);
    }

    await client.query('BEGIN');

    // Se vazio, zera vínculos
    if (!ids || ids.length === 0) {
      await client.query('DELETE FROM public.ordem_setores WHERE ordem_id = $1', [ordemId]);
      await client.query('COMMIT');
      return res.json({ ok: true, setores: [] });
    }

    // Remove os que não estão mais na lista
    await client.query(
      `DELETE FROM public.ordem_setores
        WHERE ordem_id = $1
          AND setor_id NOT IN (SELECT unnest($2::int[]))`,
      [ordemId, ids]
    );

    // Insere novos vínculos (idempotente)
    const colTemStatus = await temColunaStatus();
    for (const sid of ids) {
      if (colTemStatus) {
        await client.query(
          `INSERT INTO public.ordem_setores (ordem_id, setor_id, status)
           VALUES ($1, $2, 'aguardando')
           ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
          [ordemId, sid]
        );
      } else {
        await client.query(
          `INSERT INTO public.ordem_setores (ordem_id, setor_id)
           VALUES ($1, $2)
           ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
          [ordemId, sid]
        );
      }
    }

    await client.query('COMMIT');

    // Retorna fotografia atual
    const { rows } = await db.query(
      `SELECT s.id, s.slug, s.nome
         FROM public.ordem_setores os
         JOIN public.setores s ON s.id = os.setor_id
        WHERE os.ordem_id = $1
        ORDER BY s.ordem_exibicao NULLS LAST, s.nome`,
      [ordemId]
    );

    return res.json({ ok: true, setores: rows });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /ordens-uniformes/:ordemId/setores erro:', e);
    return res.status(500).json({ erro: 'Falha ao salvar setores da ordem.' });
  } finally {
    client.release();
  }
});

export default router;
