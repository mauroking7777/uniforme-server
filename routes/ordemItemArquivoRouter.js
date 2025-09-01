// routes/ordemItemArquivoRouter.js
import express from 'express';
import path from 'node:path';
import crypto from 'crypto';
import multer from 'multer';

import db from '../db.js';
import { auth as requireAuth } from './auth.js';
import { r2 } from './r2Client.js';

import {
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
  R2_BUCKET,
  CDR_MAX_MB = '256',
} = process.env;

const CDR_MAX_BYTES = parseInt(CDR_MAX_MB, 10) * 1024 * 1024;

if (!R2_BUCKET) {
  console.warn('[ordemItemArquivoRouter] R2_BUCKET não definido.');
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
  const type = String(contentType || '').toLowerCase();
  const allowed = new Set([
    'application/x-coreldraw',
    'image/x-coreldraw',
    'application/vnd.corel-draw',
    'application/cdr',
    'image/cdr',
    '',
    'application/octet-stream',
  ]);
  return okExt && allowed.has(type);
}

function onlyImage(nome, contentType) {
  const ext = String(nome || '').toLowerCase().split('.').pop();
  const okExt = ['png','jpg','jpeg'].includes(ext);
  const type = String(contentType || '').toLowerCase();
  const allowed = new Set(['image/png','image/jpeg','image/jpg']);
  return okExt && allowed.has(type);
}

function buildPreviewKey(ordemId, itemId, originalName) {
  const base = sanitizeFileName((originalName || 'preview').replace(/\.(png|jpg|jpeg)$/i, ''));
  const ext = (originalName || '').toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  return `previews/${ordemId}/${itemId}/${Date.now()}_${crypto.randomUUID()}_${base}.${ext}`;
}

function buildKey(ordemId, itemId, originalName) {
  const base = sanitizeFileName((originalName || 'layout').replace(/\.cdr$/i, ''));
  return `ordens/${ordemId}/itens/${itemId}/corel/${Date.now()}_${crypto.randomUUID()}_${base}.cdr`;
}

function buildListKey(ordemId, itemId, nomeBase = 'lista-nomes.json') {
  const base = sanitizeFileName(nomeBase.replace(/\.json$/i, ''));
  return `ordens/${ordemId}/itens/${itemId}/listas/${Date.now()}_${crypto.randomUUID()}_${base}.json`;
}

async function assertItemDaOrdem(ordemId, itemId) {
  const q = await db.query(
    'SELECT 1 FROM ordem_producao_uniformes_dados_modelo WHERE id = $1 AND ordem_id = $2 LIMIT 1',
    [itemId, ordemId]
  );
  return q.rowCount > 0;
}

// assina GET do R2
async function presignGet(objectKey, seconds = 900, contentType) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      ...(contentType ? { ResponseContentType: contentType } : {}),
    }),
    { expiresIn: seconds }
  );
}

/* =========================================================
 * PREVIEW (PNG/JPG) — upload direto pelo front (presign)
 * ========================================================= */

// 1) Gera URL de PUT no R2
router.post('/:ordemId/itens/:itemId/preview/upload-url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { nome_arquivo, content_type, tamanho_bytes } = req.body || {};

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!nome_arquivo || !content_type || !Number.isFinite(Number(tamanho_bytes))) {
      return res.status(400).json({ erro: 'Parâmetros inválidos.' });
    }
    if (!onlyImage(nome_arquivo, content_type)) {
      return res.status(415).json({ erro: 'Apenas PNG ou JPG/JPEG.' });
    }

    const Key = buildPreviewKey(ordemId, itemId, nome_arquivo);
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: Key,
      ContentType: content_type,
      ContentLength: Number(tamanho_bytes),
      CacheControl: 'public, max-age=31536000, immutable'
    });
    const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 15 * 60 });

    // deixa status "pending" até o confirm
    await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
         SET preview_status = 'pending',
             preview_error = NULL,
             preview_updated_at = NOW()
       WHERE id = $1`,
      [itemId]
    );

    return res.json({ objectKey: Key, uploadUrl, expiresInSec: 900 });
  } catch (e) {
    console.error('preview upload-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de upload de preview.' });
  }
});

// 2) Confirma o preview após o PUT no R2
router.post('/:ordemId/itens/:itemId/preview/confirm', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { objectKey } = req.body || {};
    if (!objectKey) return res.status(400).json({ erro: 'objectKey ausente.' });
    if (!String(objectKey).startsWith(`previews/${ordemId}/${itemId}/`)) {
      return res.status(400).json({ erro: 'objectKey não confere com ordem/item.' });
    }

    await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
         SET preview_status = 'ready',
             preview_object_key = $2,
             preview_error = NULL,
             preview_updated_at = NOW()
       WHERE id = $1`,
      [itemId, objectKey]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('preview confirm erro:', e);
    return res.status(500).json({ erro: 'Falha ao confirmar preview.' });
  }
});

/* =========================================================
 * CDR (upload via multipart OU via presigned PUT)
 * ========================================================= */

// 3) Upload direto do CDR (multipart) — agora aceita CDR + lista + PNG
router.post(
  '/:ordemId/itens/:itemId/cdr/upload',
  requireAuth,
  upload.fields([
    { name: 'file', maxCount: 1 },         // CDR (obrigatório)
    { name: 'lista_nomes', maxCount: 1 },  // JSON (opcional)
    { name: 'preview_png', maxCount: 1 },  // PNG/JPG (opcional)  ✅ NOVO
  ]),
  async (req, res) => {
    try {
      const { ordemId, itemId } = req.params;

      if (!(await assertItemDaOrdem(ordemId, itemId))) {
        return res.status(400).json({ error: 'Item não pertence à ordem informada.' });
      }

      // === CDR (obrigatório)
      const cdr = (req.files?.file || [])[0];
      if (!cdr) {
        return res.status(400).json({ error: 'Arquivo (.cdr) é obrigatório (campo "file").' });
      }
      const ext = path.extname(cdr.originalname || '').toLowerCase();
      if (ext !== '.cdr' || !onlyCDR(cdr.originalname, cdr.mimetype)) {
        return res.status(415).json({ error: 'Apenas arquivos .cdr são aceitos.' });
      }
      if (cdr.size > CDR_MAX_BYTES) {
        return res.status(413).json({ error: `Arquivo maior que ${CDR_MAX_MB}MB` });
      }

      const keyCdr = buildKey(ordemId, itemId, cdr.originalname);
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: keyCdr,
        Body: cdr.buffer,
        ContentType: cdr.mimetype || 'application/octet-stream',
        ContentLength: cdr.size,
      }));

      // soft-delete de CDRs anteriores do item
      await db.query(
        `UPDATE ordem_item_arquivo
           SET deleted_at = NOW()
         WHERE item_id = $1
           AND deleted_at IS NULL
           AND key LIKE '%/corel/%'`,
        [itemId]
      );

      // registra o CDR
      const insCdr = await db.query(
        `INSERT INTO ordem_item_arquivo
           (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
         RETURNING id`,
        [
          ordemId,
          itemId,
          keyCdr,
          cdr.originalname || 'layout.cdr',
          cdr.mimetype || 'application/octet-stream',
          cdr.size,
          req.user?.id || null,
        ]
      );

      // === LISTA DE NOMES (opcional)
      let listaSaved = null;
      const lista = (req.files?.lista_nomes || [])[0];
      if (lista) {
        const keyLista = buildListKey(ordemId, itemId);
        await r2.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: keyLista,
          Body: lista.buffer,
          ContentType: 'application/json; charset=utf-8',
          ContentLength: lista.size,
        }));

        // soft-delete apenas das LISTAS anteriores
        await db.query(
          `UPDATE ordem_item_arquivo
             SET deleted_at = NOW()
           WHERE item_id = $1 AND deleted_at IS NULL AND key LIKE '%/listas/%'`,
          [itemId]
        );

        const insLista = await db.query(
          `INSERT INTO ordem_item_arquivo
             (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
            RETURNING id`,
          [
            ordemId,
            itemId,
            keyLista,
            'lista-nomes.json',
            'application/json',
            lista.size,
            req.user?.id || null,
          ]
        );

        listaSaved = { id: insLista.rows[0].id, key: keyLista };
      }

      // === PREVIEW PNG/JPG (opcional)  ✅ NOVO
      let previewSaved = null;
      const png = (req.files?.preview_png || [])[0];
      if (png) {
        if (!onlyImage(png.originalname, png.mimetype)) {
          return res.status(415).json({ error: 'preview_png: somente PNG ou JPG/JPEG.' });
        }

        const keyPreview = buildPreviewKey(ordemId, itemId, png.originalname);
        await r2.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: keyPreview,
          Body: png.buffer,
          ContentType: png.mimetype || 'image/png',
          ContentLength: png.size,
          CacheControl: 'public, max-age=31536000, immutable',
        }));

        // Atualiza status/ponteiro do preview no item
        await db.query(
          `UPDATE ordem_producao_uniformes_dados_modelo
              SET preview_status = 'ready',
                  preview_object_key = $2,
                  preview_error = NULL,
                  preview_updated_at = NOW()
            WHERE id = $1`,
          [itemId, keyPreview]
        );

        previewSaved = {
          key: keyPreview,
          content_type: png.mimetype || 'image/png',
          tamanho_bytes: png.size,
        };
      }

      return res.json({
        ok: true,
        cdr: { id: insCdr.rows[0].id, key: keyCdr },
        lista: listaSaved,
        preview: previewSaved, // ✅ presente quando PNG/JPG enviado
      });
    } catch (e) {
      console.error('Erro no upload .cdr:', e);
      if (e?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Arquivo maior que ${CDR_MAX_MB}MB` });
      }
      return res.status(500).json({
        error: 'Falha ao concluir upload/registro do CDR.',
        detail: e?.message || String(e),
        pgcode: e?.code || null
      });
    }
  }
);

// 4) Presigned PUT para CDR (front faz o PUT) – inalterado
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
    const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 15 * 60 });

    return res.json({ objectKey: Key, uploadUrl, expiresInSec: 900 });
  } catch (e) {
    console.error('upload-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de upload.' });
  }
});

// 5) Confirma o CDR após o PUT (registra no BD) – inalterado
router.post('/:ordemId/itens/:itemId/cdr/confirm', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { objectKey, nome_original, content_type, tamanho_bytes } = req.body || {};

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!objectKey || !/\.cdr$/i.test(objectKey)) {
      return res.status(400).json({ erro: 'objectKey inválido (precisa ser um .cdr).' });
    }
    if (!String(objectKey).includes(`/ordens/${ordemId}/itens/${itemId}/`)) {
      return res.status(400).json({ erro: 'objectKey não confere com a ordem/item.' });
    }

    // Desativa CDRs anteriores deste item
    await db.query(
      `UPDATE ordem_item_arquivo
         SET deleted_at = NOW()
       WHERE item_id = $1 AND deleted_at IS NULL AND key LIKE '%/corel/%'`,
      [itemId]
    );

    // Registra o novo arquivo
    const { rows } = await db.query(
      `INSERT INTO ordem_item_arquivo
         (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
       RETURNING id, key, created_at`,
      [
        ordemId,
        itemId,
        objectKey,
        nome_original || 'layout.cdr',
        content_type || 'application/octet-stream',
        Number(tamanho_bytes) || null,
        req.user?.id || null,
      ]
    );

    // (sem CloudConvert / sem tocar preview aqui)
    res.json({ ok: true, arquivo: rows[0] });
  } catch (e) {
    console.error('cdr/confirm erro:', e);
    res.status(500).json({ erro: 'Falha ao registrar arquivo' });
  }
});

/* =========================================================
 * LISTAGEM / DOWNLOAD / DELETE (inalteradas)
 * ========================================================= */

// 6) Listar arquivos ativos do item
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

// 7) URL do CDR mais recente (download)
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
          AND key LIKE '%/corel/%'
        ORDER BY created_at DESC
        LIMIT 1`,
      [ordemId, itemId]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ erro: 'Nenhum CDR ativo para este item.' });
    }

    const { key, nome_original, content_type } = q.rows[0];
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ResponseContentType: content_type || 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(nome_original)}"`,
      }),
      { expiresIn: 60 * 10 }
    );

    return res.json({ url, expiresInSec: 600 });
  } catch (e) {
    console.error('download-url (último) erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL de download.' });
  }
});

// 8) URL genérica por ID (CDR/JSON)
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
      r2,
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

// 9) URL da LISTA DE NOMES mais recente
router.get('/:ordemId/itens/:itemId/lista-nomes/url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }

    const q = await db.query(
      `SELECT id, key, nome_original
         FROM ordem_item_arquivo
        WHERE ordem_id = $1
          AND item_id  = $2
          AND deleted_at IS NULL
          AND content_type = 'application/json'
        ORDER BY created_at DESC
        LIMIT 1`,
      [ordemId, itemId]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ erro: 'Nenhuma lista de nomes ativa para este item.' });
    }

    const { key, nome_original } = q.rows[0];
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ResponseContentType: 'application/json; charset=utf-8',
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(nome_original)}"`,
      }),
      { expiresIn: 60 * 10 }
    );

    return res.json({ url, expiresInSec: 600 });
  } catch (e) {
    console.error('lista-nomes url erro:', e);
    res.status(500).json({ erro: 'Falha ao gerar URL da lista de nomes.' });
  }
});

// 10) DELETE (soft + tenta remover do R2)
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

    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.warn('Falha ao remover do R2 (seguindo com soft-delete):', e?.message);
    }

    await client.query('UPDATE ordem_item_arquivo SET deleted_at = NOW() WHERE id = $1', [arquivoId]);

    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE arquivo erro:', e);
    res.status(500).json({ erro: 'Falha ao excluir arquivo' });
  } finally {
    client.release();
  }
});

export default router;
