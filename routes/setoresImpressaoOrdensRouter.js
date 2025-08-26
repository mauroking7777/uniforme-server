// routes/setoresImpressaoOrdensRouter.js
import express from 'express';
import pool from '../db.js';
import { auth as requireAuth } from './auth.js';

const router = express.Router();

/**
 * GET /setores/impressao/ordens
 * Lista ordens filtradas para o Setor de Impressão.
 *
 * Query params (opcionais):
 *  - status: string | lista separada por vírgula (ex.: "recebido,configurado")
 *  - q: termo de busca (cliente, vendedor, número da ordem)
 *  - limit: número (default 50, máx 200)
 *  - offset: número (default 0)
 *  - sort: "data_entrada desc" | "data_entrada asc" | "data_entrega desc" | "data_entrega asc"
 *
 * Observações:
 *  - Garante tipo_ordem = 'Produção de Impressão'
 *  - Mantém os campos exatamente como o front usa (snake_case no backend)
 */
router.get('/setores/impressao/ordens', requireAuth, async (req, res) => {
  try {
    const rawStatus = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();
    const sort = (req.query.sort || 'data_entrada desc').toLowerCase();

    let limit = Number(req.query.limit ?? 50);
    let offset = Number(req.query.offset ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    // status permitidos (como na UI)
    let statusList = [];
    if (rawStatus) {
      statusList = rawStatus
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => ['recebido', 'configurado', 'devolvido', 'impresso'].includes(s));
    }

    // ordenação segura
    const allowedSort = new Set([
      'data_entrada desc',
      'data_entrada asc',
      'data_entrega desc',
      'data_entrega asc'
    ]);
    const orderBy = allowedSort.has(sort) ? sort : 'data_entrada desc';

    // onde (tipo de ordem fixo + filtros opcionais)
    const where = [`o.tipo_ordem = 'Produção de Impressão'`];
    const values = [];
    let idx = 1;

    if (statusList.length > 0) {
      where.push(`o.status = ANY($${idx}::text[])`);
      values.push(statusList);
      idx++;
    }

    if (q) {
      where.push(`(
        o.cliente ILIKE $${idx}
        OR u.nome ILIKE $${idx}
        OR CAST(o.numero_ordem AS TEXT) ILIKE $${idx}
      )`);
      values.push(`%${q}%`);
      idx++;
    }

    const sql = `
      SELECT
        o.id,
        o.cliente,
        u.nome AS vendedor,
        o.tipo_ordem,
        o.data_entrada,
        o.data_entrega,
        o.status
      FROM public.ordem_producao_uniformes_dados_ordem o
      LEFT JOIN public.usuarios u ON u.id = o.usuario_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    values.push(limit, offset);

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar ordens do Setor de Impressão:', err);
    res.status(500).json({ erro: 'Erro ao listar ordens do Setor de Impressão.' });
  }
});

export default router;
