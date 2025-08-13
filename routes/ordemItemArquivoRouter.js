// routes/ordemItemArquivoRouter.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db.js';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';


// ===== Config =====
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  JWT_SECRET = 'uniforme-secret-key',
  CDR_MAX_MB = '250',
} = process.env;

const CDR_MAX_BYTES = parseInt(CDR_MAX_MB, 10) * 1024 * 1024;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

const router = express.Router();

// ===== Helpers =====
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ erro: 'Sem token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      nome: payload.nome,
      funcao: payload.funcao,
      setor: payload.setor,
      is_admin: payload.is_admin,
    };
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido' });
  }
}

function onlyCDR(nome, contentType) {
  const okExt = String(nome || '').toLowerCase().endsWith('.cdr');
  const type = String(contentType || '').toLowerCase();
  const okType =
    type === 'application/x-coreldraw' ||
    type === 'image/x-coreldraw' ||
    type === 'application/octet-stream';
  return okExt && okType;
}

function buildKey(ordemId, itemId) {
  return `ordens/${ordemId}/itens/${itemId}/corel/${Date.now()}-${crypto.randomUUID()}.cdr`;
}

async function assertItemDaOrdem(ordemId, itemId) {
  const q = await db.query(
    'SELECT 1 FROM ordem_producao_uniformes_dados_modelo WHERE id = $1 AND ordem_id = $2 LIMIT 1',
    [itemId, ordemId]
  );
  return q.rowCount > 0;
}

// ===== 1) Upload URL =====
router.post('/ordens/:ordemId/itens/:itemId/cdr/upload-url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { nome_arquivo, content_type, tamanho_bytes } = req.body || {};

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!nome_arquivo || !content_type || !Number.isFinite(Number(tamanho_bytes))) {
      return res.status(400).json({ erro: 'Parâmetros inválidos.' });
    }
    if (!onlyCDR(nome_arquivo, content_type)) {
      return res.status(415).json({ erro: 'Apenas arquivos .cdr são aceitos.' });
    }
    if (Number(tamanho_bytes) > CDR_MAX_BYTES) {
      return res.status(413).json({ erro: `Arquivo acima de ${CDR_MAX_MB} MB.` });
    }

    const Key = buildKey(ordemId, itemId);
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key,
      ContentType: content_type,
    });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 15 * 60 }); // 15 min

    return res.json({ objectKey: Key, uploadUrl, expiresInSec: 900 });
  } catch (e) {
    console.error('upload-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de upload.' });
  }
});

// ===== 2) Confirmar upload =====
router.post('/ordens/:ordemId/itens/:itemId/cdr/confirm', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { ordemId, itemId } = req.params;
    const { objectKey, tamanho_bytes, hash, nome_original, content_type } = req.body || {};

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!objectKey || !nome_original || !content_type || !Number.isFinite(Number(tamanho_bytes))) {
      return res.status(400).json({ erro: 'Parâmetros inválidos.' });
    }
    if (!onlyCDR(nome_original, content_type)) {
      return res.status(415).json({ erro: 'Apenas arquivos .cdr são aceitos.' });
    }
    if (Number(tamanho_bytes) > CDR_MAX_BYTES) {
      return res.status(413).json({ erro: `Arquivo acima de ${CDR_MAX_MB} MB.` });
    }

    const esperado = `ordens/${ordemId}/itens/${itemId}/corel/`;
    if (!String(objectKey).startsWith(esperado)) {
      return res.status(400).json({ erro: 'objectKey não corresponde à ordem/item informados.' });
    }

    await client.query('BEGIN');

    // Soft-delete do ativo anterior (se existir)
    await client.query(
      `UPDATE ordem_item_arquivo
         SET deleted_at = NOW()
       WHERE item_id = $1 AND deleted_at IS NULL`,
      [itemId]
    );

    // Insere novo registro ativo
    const ins = await client.query(
      `INSERT INTO ordem_item_arquivo
         (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
       RETURNING id`,
      [ordemId, itemId, objectKey, nome_original, content_type, Number(tamanho_bytes), req.user.id]
    );

    await client.query('COMMIT');
    return res.json({ arquivo_id: ins.rows[0].id, status: 'uploaded', hash: hash || null });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('confirm erro:', e);
    return res.status(500).json({ erro: 'Falha ao confirmar upload.' });
  } finally {
    client.release();
  }
});

// ===== 3) Download URL =====
router.post('/ordens/:ordemId/itens/:itemId/cdr/download-url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }

    const q = await db.query(
      `SELECT key
         FROM ordem_item_arquivo
        WHERE ordem_id = $1
          AND item_id  = $2
          AND deleted_at IS NULL
          AND status = 'uploaded'
        LIMIT 1`,
      [ordemId, itemId]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ erro: 'Nenhum CDR ativo para este item.' });
    }

    const Key = q.rows[0].key;
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 5 * 60 }); // 5 min
    return res.json({ url, expiresInSec: 300 });
  } catch (e) {
    console.error('download-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de download.' });
  }
});

export default router;
