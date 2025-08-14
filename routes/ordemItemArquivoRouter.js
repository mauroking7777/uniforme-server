// routes/ordemItemArquivoRouter.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'node:path';
import multer from 'multer';
import db from '../db.js';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = express.Router();

/* =========================
 * ENV / CONFIG
 * ========================= */
const {
  R2_ENDPOINT,               // ex: https://<account>.r2.cloudflarestorage.com (recomendado)
  R2_ACCOUNT_ID,             // alternativo, se não usar R2_ENDPOINT
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  JWT_SECRET = 'uniforme-secret-key',
  CDR_MAX_MB = '256',        // limite (MB) também usado no multer
} = process.env;

const CDR_MAX_BYTES = parseInt(CDR_MAX_MB, 10) * 1024 * 1024;
const endpoint =
  R2_ENDPOINT ||
  (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

if (!endpoint) {
  console.warn('[ordemItemArquivoRouter] R2 endpoint não configurado. Defina R2_ENDPOINT ou R2_ACCOUNT_ID.');
}
if (!R2_BUCKET) {
  console.warn('[ordemItemArquivoRouter] R2_BUCKET não definido.');
}

/* =========================
 * S3 / R2 CLIENT
 * ========================= */
const s3 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

/* =========================
 * AUTH MIDDLEWARE
 * ========================= */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido/expirado' });
  }
}

/* =========================
 * MULTER (memória + limite)
 * ========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CDR_MAX_BYTES },
});

/* =========================
 * HELPERS
 * ========================= */
function sanitizeFileName(name) {
  return String(name).normalize('NFKD').replace(/[^\w.\-]+/g, '_').slice(0, 140);
}

function onlyCDR(nome, contentType) {
  const okExt = String(nome || '').toLowerCase().endsWith('.cdr');
  const type = (String(contentType || '') || 'application/octet-stream').toLowerCase();
  const okType =
    type === 'application/x-coreldraw' ||
    type === 'image/x-coreldraw' ||
    type === 'application/octet-stream';
  return okExt && okType;
}

function buildKey(ordemId, itemId, originalName) {
  const base = sanitizeFileName(originalName.replace(/\.cdr$/i, ''));
  return `ordens/${ordemId}/itens/${itemId}/corel/${Date.now()}_${crypto.randomUUID()}_${base}.cdr`;
}

async function assertItemDaOrdem(ordemId, itemId) {
  const q = await db.query(
    'SELECT 1 FROM ordem_producao_uniformes_dados_modelo WHERE id = $1 AND ordem_id = $2 LIMIT 1',
    [itemId, ordemId]
  );
  return q.rowCount > 0;
}

/* =========================================================
 * 1) UPLOAD DIRETO (multipart/form-data, campo "file")
 *    POST  /ordens/:ordemId/itens/:itemId/cdr/upload
 * ========================================================= */
router.post(
  '/:ordemId/itens/:itemId/cdr/upload',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      const { ordemId, itemId } = req.params;

      // Checa se o item realmente pertence à ordem
      if (!(await assertItemDaOrdem(ordemId, itemId))) {
        return res.status(400).json({ error: 'Item não pertence à ordem informada.' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Arquivo (.cdr) é obrigatório (campo "file").' });
      }

      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (ext !== '.cdr' || !onlyCDR(req.file.originalname, req.file.mimetype)) {
        return res.status(415).json({ error: 'Apenas arquivos .cdr são aceitos.' });
      }

      const key = buildKey(ordemId, itemId, req.file.originalname);

      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || 'application/octet-stream',
          ContentLength: req.file.size,
        })
      );

      // Soft-delete de arquivos ativos anteriores deste item
      await db.query(
        `UPDATE ordem_item_arquivo
           SET deleted_at = NOW()
         WHERE item_id = $1 AND deleted_at IS NULL`,
        [itemId]
      );

      // Insere o novo registro "uploaded"
      const insertSql = `
        INSERT INTO ordem_item_arquivo
          (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
        RETURNING id, ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_at;
      `;
      const { rows } = await db.query(insertSql, [
        ordemId,
        itemId,
        key,
        req.file.originalname,
        req.file.mimetype || 'application/octet-stream',
        req.file.size,
        req.user?.id || null,
      ]);

      return res.json({ ok: true, arquivo: rows[0] });
    } catch (e) {
      console.error('Erro no upload .cdr:', e);
      if (e?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Arquivo maior que ${CDR_MAX_MB}MB` });
      }
      return res.status(500).json({ error: 'Falha ao enviar arquivo para o R2.' });
    }
  }
);

/* =========================================================
 * 2) LISTAR ARQUIVOS DO ITEM
 *    GET   /ordens/:ordemId/itens/:itemId/cdr/list
 * ========================================================= */
router.get('/:ordemId/itens/:itemId/cdr/list', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }

    const q = await db.query(
      `SELECT
         id, ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_at
       FROM ordem_item_arquivo
       WHERE ordem_id = $1
         AND item_id  = $2
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [ordemId, itemId]
    );

    res.json(q.rows);
  } catch (e) {
    console.error('LIST CDR ERRO:', e);
    res.status(500).json({ erro: 'Falha ao listar arquivos' });
  }
});

/* =========================================================
 * 3a) DOWNLOAD URL DO ÚLTIMO ARQUIVO ATIVO DO ITEM
 *     GET   /ordens/:ordemId/itens/:itemId/cdr/download-url
 * ========================================================= */
router.get('/:ordemId/itens/:itemId/cdr/download-url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }

    const q = await db.query(
      `SELECT id, key, nome_original, content_type
         FROM ordem_item_arquivo
        WHERE ordem_id = $1
          AND item_id  = $2
          AND deleted_at IS NULL
          AND status = 'uploaded'
        ORDER BY created_at DESC
        LIMIT 1`,
      [ordemId, itemId]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ erro: 'Nenhum CDR ativo para este item.' });
    }

    const { key, nome_original, content_type } = q.rows[0];
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ResponseContentType: content_type || 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(nome_original)}"`,
      }),
      { expiresIn: 60 * 10 } // 10 min
    );

    return res.json({ url, expiresInSec: 600 });
  } catch (e) {
    console.error('download-url (último) erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de download.' });
  }
});

/* =========================================================
 * 3b) DOWNLOAD URL POR ID DO ARQUIVO
 *     GET   /ordens/arquivos/:arquivoId/url
 * ========================================================= */
router.get('/arquivos/:arquivoId/url', requireAuth, async (req, res) => {
  try {
    const { arquivoId } = req.params;
    const { rows } = await db.query(
      `SELECT key, nome_original, content_type
         FROM ordem_item_arquivo
        WHERE id = $1 AND deleted_at IS NULL`,
      [arquivoId]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Arquivo não encontrado' });

    const { key, nome_original, content_type } = rows[0];
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ResponseContentType: content_type || 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(nome_original)}"`,
      }),
      { expiresIn: 60 * 10 }
    );

    res.json({ url, expiresInSec: 600 });
  } catch (e) {
    console.error('download-url (por id) erro:', e);
    res.status(500).json({ erro: 'Falha ao gerar URL' });
  }
});

/* =========================================================
 * 4) (OPCIONAL) EXCLUIR ARQUIVO (R2 + soft-delete)
 *     DELETE /ordens/arquivos/:arquivoId
 * ========================================================= */
router.delete('/arquivos/:arquivoId', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { arquivoId } = req.params;

    const { rows } = await client.query(
      `SELECT key FROM ordem_item_arquivo WHERE id = $1 AND deleted_at IS NULL`,
      [arquivoId]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Arquivo não encontrado' });

    const key = rows[0].key;

    // remove do R2 (se existir)
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.warn('Falha ao remover do R2 (seguindo com soft-delete):', e?.message);
    }

    // soft-delete no banco
    await client.query('UPDATE ordem_item_arquivo SET deleted_at = NOW() WHERE id = $1', [arquivoId]);

    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE arquivo erro:', e);
    res.status(500).json({ erro: 'Falha ao excluir arquivo' });
  } finally {
    client.release();
  }
});

/* =========================================================
 * (Opcional) Fluxo PRESIGNED PUT (se quiser manter)
 *  POST /:ordemId/itens/:itemId/cdr/upload-url   -> retorna URL de PUT
 *  POST /:ordemId/itens/:itemId/cdr/confirm      -> grava no banco
 *  (Você está usando upload direto no front. Esses endpoints ficam
 *   disponíveis só se decidir voltar para presigned PUT.)
 * ========================================================= */

// Gera URL pré-assinada para PUT
router.post('/:ordemId/itens/:itemId/cdr/upload-url', requireAuth, async (req, res) => {
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

    const Key = buildKey(ordemId, itemId, nome_arquivo);
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key,
      ContentType: content_type,
      ContentLength: Number(tamanho_bytes),
    });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 15 * 60 }); // 15 min

    return res.json({ objectKey: Key, uploadUrl, expiresInSec: 900 });
  } catch (e) {
    console.error('upload-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de upload.' });
  }
});

// Confirma o upload (grava no banco)
router.post('/:ordemId/itens/:itemId/cdr/confirm', requireAuth, async (req, res) => {
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
      [ordemId, itemId, objectKey, nome_original, content_type, Number(tamanho_bytes), req.user?.id || null]
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

export default router;
