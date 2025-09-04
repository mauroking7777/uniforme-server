// routes/setorConfiguracaoRouter.js
import express from 'express';
import pool from '../db.js';
import { auth as requireAuth } from './auth.js';
// R2 (Cloudflare) – cliente e assinatura
import { r2 } from './r2Client.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';


const router = express.Router();

// Util: checa se a OP tem o setor "configuracao" vinculado e retorna status atual
async function getStatusConfig(ordemId) {
  const sql = `
    SELECT os.*, s.slug
      FROM public.ordem_setores os
      JOIN public.setores s ON s.id = os.setor_id
     WHERE os.ordem_id = $1 AND s.slug = 'configuracao'
     LIMIT 1
  `;
  const r = await pool.query(sql, [Number(ordemId)]);
  return r.rows[0] || null;
}

/**
 * GET /setores/configuracao/ordens
 * Lista OPs que têm o setor "configuracao" vinculado (cadeia da sublimação).
 * Filtros: ?status=aguardando,recebido,devolvido,configurado  |  ?q=termo  |  ?limit  ?offset  |  ?sort=entrada|entrega:(asc|desc)
 */
router.get('/setores/configuracao/ordens', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rawStatus = (req.query.status || '').trim().toLowerCase();
    const allowed = new Set(['aguardando','recebido','devolvido','configurado']);
    const statusList = rawStatus
      ? rawStatus.split(',').map(s => s.trim()).filter(s => allowed.has(s))
      : [];

    const sortRaw = (req.query.sort || 'entrada:desc').toLowerCase();
    const sortMap = {
      'entrada:asc':  'o.data_entrada ASC',
      'entrada:desc': 'o.data_entrada DESC',
      'entrega:asc':  'o.data_entrega ASC',
      'entrega:desc': 'o.data_entrega DESC',
    };
    const orderBy = sortMap[sortRaw] || sortMap['entrada:desc'];

    let limit = Number(req.query.limit ?? 50);
    let offset = Number(req.query.offset ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const where = [`s.slug = 'configuracao'`];
    const params = [];
    let idx = 1;

    if (statusList.length > 0) {
      where.push(`LOWER(os.status) = ANY($${idx}::text[])`);
      params.push(statusList);
      idx++;
    }
    if (q) {
      where.push(`(
        o.cliente ILIKE $${idx}
        OR u.nome ILIKE $${idx}
        OR CAST(o.numero_ordem AS TEXT) ILIKE $${idx}
      )`);
      params.push(`%${q}%`);
      idx++;
    }

    const sql = `
      SELECT
        o.id,
        o.numero_ordem,
        o.cliente,
        u.nome AS vendedor,
        o.tipo_ordem,
        o.data_entrada,
        o.data_entrega,
        LOWER(os.status) AS status
      FROM public.ordem_producao_uniformes_dados_ordem o
      JOIN public.ordem_setores os ON os.ordem_id = o.id
      JOIN public.setores s ON s.id = os.setor_id
      LEFT JOIN public.usuarios u ON u.id = o.usuario_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    params.push(limit, offset);

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /setores/configuracao/ordens erro:', err);
    res.status(500).json({ erro: 'Falha ao listar ordens do Setor de Configuração.' });
  }
});

/** POST /setores/configuracao/ordens/:ordemId/receber
 * Regras:
 *  - Apenas se status atual = 'aguardando'
 *  - Marca recebido_por/recebido_em
 */
router.post('/setores/configuracao/ordens/:ordemId/receber', requireAuth, async (req, res) => {
  const { ordemId } = req.params;
  try {
    const os = await getStatusConfig(ordemId);
    if (!os) return res.status(404).json({ erro: 'Ordem sem setor de configuração.' });
    if (String(os.status).toLowerCase() !== 'aguardando') {
      return res.status(409).json({ erro: `Estado inválido: ${os.status}. Esperado: aguardando.` });
    }

    await pool.query(
      `UPDATE public.ordem_setores
          SET status = 'recebido',
              recebido_por = $1,
              recebido_em = NOW()
        WHERE ordem_id = $2 AND setor_id = $3`,
      [req.user?.id || null, os.ordem_id, os.setor_id]
    );

    res.json({ ok: true, novo_status: 'recebido' });
  } catch (err) {
    console.error('POST receber (configuração) erro:', err);
    res.status(500).json({ erro: 'Falha ao receber a ordem no Setor de Configuração.' });
  }
});

/** POST /setores/configuracao/ordens/:ordemId/devolver  { motivo }
 * Regras:
 *  - Permitido de 'aguardando' ou 'recebido'
 *  - Grava motivo e carimbo de devolução
 */
router.post('/setores/configuracao/ordens/:ordemId/devolver', requireAuth, async (req, res) => {
  const { ordemId } = req.params;
  const { motivo } = req.body || {};
  try {
    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({ erro: 'motivo é obrigatório.' });
    }

    const os = await getStatusConfig(ordemId);
    if (!os) return res.status(404).json({ erro: 'Ordem sem setor de configuração.' });

    const st = String(os.status).toLowerCase();
    if (!['aguardando','recebido'].includes(st)) {
      return res.status(409).json({ erro: `Estado inválido: ${os.status}. Permitidos: aguardando/recebido.` });
    }

    await pool.query(
      `UPDATE public.ordem_setores
          SET status = 'devolvido',
              devolvido_por = $1,
              devolvido_em = NOW(),
              motivo_devolucao = $2
        WHERE ordem_id = $3 AND setor_id = $4`,
      [req.user?.id || null, motivo, os.ordem_id, os.setor_id]
    );

    // Observação: quando o vendedor ajustar e ENVIAR novamente, você pode restaurar para 'aguardando' nesse mesmo registro.
    res.json({ ok: true, novo_status: 'devolvido' });
  } catch (err) {
    console.error('POST devolver (configuração) erro:', err);
    res.status(500).json({ erro: 'Falha ao devolver a ordem no Setor de Configuração.' });
  }
});

/** POST /setores/configuracao/ordens/:ordemId/concluir
 * Regras:
 *  - Apenas se status atual = 'recebido'
 *  - Seta status = 'configurado' e concluido_em
 *  - (A liberação das próximas etapas será checada nas telas de Impressão/Sublimação)
 */
router.post('/setores/configuracao/ordens/:ordemId/concluir', requireAuth, async (req, res) => {
  const { ordemId } = req.params;
  try {
    const os = await getStatusConfig(ordemId);
    if (!os) return res.status(404).json({ erro: 'Ordem sem setor de configuração.' });
    if (String(os.status).toLowerCase() !== 'recebido') {
      return res.status(409).json({ erro: `Estado inválido: ${os.status}. Esperado: recebido.` });
    }

    await pool.query(
      `UPDATE public.ordem_setores
          SET status = 'configurado',
              concluido_em = NOW()
        WHERE ordem_id = $1 AND setor_id = $2`,
      [os.ordem_id, os.setor_id]
    );

    res.json({ ok: true, novo_status: 'configurado' });
  } catch (err) {
    console.error('POST concluir (configuração) erro:', err);
    res.status(500).json({ erro: 'Falha ao concluir a configuração da ordem.' });
  }
});

/**
 * GET /ordens/:ordemId/itens/:itemId/cdr/preview-url
 * Retorna URL ASSINADA para visualizar o preview do layout (imagem no R2).
 *
 * Regra:
 * 1) Tenta ler `preview_object_key` da tabela do item (ordem_producao_uniformes_dados_modelo).
 * 2) Se não tiver, tenta pegar o último arquivo de imagem do item em `ordem_item_arquivo`.
 */
 router.get('/ordens/:ordemId/itens/:itemId/cdr/preview-url', requireAuth, async (req, res) => {
  const { ordemId, itemId } = req.params;
  try {
    // 1) tenta preview_object_key direto do item
    const q1 = await pool.query(
      `SELECT preview_object_key
         FROM ordem_producao_uniformes_dados_modelo
        WHERE id = $1 AND ordem_id = $2
        LIMIT 1`,
      [itemId, ordemId]
    );

    let objectKey = q1.rows[0]?.preview_object_key || null;

    // 2) fallback: último arquivo de imagem do item
    if (!objectKey) {
      const q2 = await pool.query(
        `SELECT key
           FROM ordem_item_arquivo
          WHERE item_id = $1
            AND (content_type LIKE 'image/%'
                 OR LOWER(nome_original) LIKE '%.png'
                 OR LOWER(nome_original) LIKE '%.jpg'
                 OR LOWER(nome_original) LIKE '%.jpeg'
                 OR LOWER(nome_original) LIKE '%preview%')
       ORDER BY id DESC
          LIMIT 1`,
        [itemId]
      );
      objectKey = q2.rows[0]?.key || null;
    }

    if (!objectKey) {
      return res.status(404).json({ erro: 'Preview não encontrado para este item.' });
    }

    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: objectKey }),
      { expiresIn: 60 * 60 } // 1h
    );

    return res.json({ url });
  } catch (err) {
    console.error('preview-url erro:', err);
    return res.status(500).json({ erro: 'Falha ao gerar URL do preview.' });
  }
});


/**
 * GET /ordens/:ordemId/itens/:itemId/cdr/download-url
 * Retorna URL ASSINADA para baixar o CDR do item (arquivo de layout vetorial).
 *
 * Regra:
 *  - Pega o último arquivo do item com content_type CDR ou nome terminando em .cdr
 */
router.get('/ordens/:ordemId/itens/:itemId/cdr/download-url', requireAuth, async (req, res) => {
  const { ordemId, itemId } = req.params;
  try {
    const q = await pool.query(
      `SELECT key
         FROM ordem_item_arquivo
        WHERE item_id = $1
          AND (content_type = 'application/cdr'
               OR LOWER(nome_original) LIKE '%.cdr')
     ORDER BY id DESC
        LIMIT 1`,
      [itemId]
    );

    const objectKey = q.rows[0]?.key || null;
    if (!objectKey) {
      return res.status(404).json({ erro: 'Nenhum arquivo CDR encontrado para este item.' });
    }

    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: objectKey }),
      { expiresIn: 60 * 60 } // 1h
    );

    return res.json({ url });
  } catch (err) {
    console.error('download-url erro:', err);
    return res.status(500).json({ erro: 'Falha ao gerar URL de download do CDR.' });
  }
});


export default router;
