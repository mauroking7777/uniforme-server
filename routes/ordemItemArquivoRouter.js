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
  CopyObjectCommand,
  HeadObjectCommand,
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
  // agora fica JUNTO com CDR e lista
  return `ordens/${ordemId}/itens/${itemId}/previews/${Date.now()}_${crypto.randomUUID()}_${base}.${ext}`;
}


function buildKey(ordemId, itemId, originalName) {
  const base = sanitizeFileName((originalName || 'layout').replace(/\.cdr$/i, ''));
  return `ordens/${ordemId}/itens/${itemId}/corel/${Date.now()}_${crypto.randomUUID()}_${base}.cdr`;
}

function buildListKey(ordemId, itemId, nomeBase = 'lista-nomes.json') {
  const base = sanitizeFileName(nomeBase.replace(/\.json$/i, ''));
  return `ordens/${ordemId}/itens/${itemId}/listas/${Date.now()}_${crypto.randomUUID()}_${base}.json`;
}

// ===== STAGING (layout/preview temporários para conferência) =====
function buildStageCdrKey(itemId, stageId, originalName) {
  const base = sanitizeFileName((originalName || 'layout').replace(/\.cdr$/i, ''));
  return `staging/itens/${itemId}/${stageId}/layout_${base}.cdr`;
}

function buildStagePreviewKey(itemId, stageId) {
  return `staging/itens/${itemId}/${stageId}/preview.png`;
}

async function headExists(objectKey) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
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
    if (!String(objectKey).startsWith(`ordens/${ordemId}/itens/${itemId}/previews/`)) {
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
 * LAYOUT STAGING (seleciona CDR, gera preview, confirma ou cancela)
 * ========================================================= */

// 1) Inicia estágio: sobe CDR para "staging" e marca pending
router.post('/:ordemId/itens/:itemId/layout/stage', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }

    const cdr = req.file;
    if (!cdr) return res.status(400).json({ erro: 'Arquivo .cdr é obrigatório (campo "file").' });
    if (!onlyCDR(cdr.originalname, cdr.mimetype)) {
      return res.status(415).json({ erro: 'Apenas arquivos .cdr são aceitos.' });
    }
    if (cdr.size > CDR_MAX_BYTES) {
      return res.status(413).json({ erro: `Arquivo maior que ${CDR_MAX_MB}MB.` });
    }

    const stageId = crypto.randomUUID();
    const keyStageCdr = buildStageCdrKey(itemId, stageId, cdr.originalname);

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: keyStageCdr,
      Body: cdr.buffer,
      ContentType: cdr.mimetype || 'application/octet-stream',
      ContentLength: cdr.size,
    }));

    // marca estágio em andamento e preview pendente
    await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
          SET layout_stage_id = $2,
              preview_status   = 'pending',
              preview_error    = NULL
        WHERE id = $1`,
      [itemId, stageId]
    );

    // aqui você publicará o JOB para o worker (baixar keyStageCdr e gerar preview.png em staging)
    // job: { itemId, stageId, cdr_key: keyStageCdr }

    return res.json({
      stageId,
      status: 'pending',
      cdrTempKey: keyStageCdr,
      fileOriginalName: cdr.originalname || 'layout.cdr'
    });
  } catch (e) {
    console.error('layout/stage erro:', e);
    return res.status(500).json({ erro: 'Falha ao iniciar estágio do layout.' });
  }
});

// 2) Status do estágio: pending | ok | error
router.get('/:ordemId/itens/:itemId/layout/stage/:stageId/status', requireAuth, async (req, res) => {
  try {
    const { itemId, stageId } = req.params;

    // confere se este stageId é o atual do item
    const r = await db.query(
      `SELECT layout_stage_id, preview_status, preview_error
         FROM ordem_producao_uniformes_dados_modelo
        WHERE id = $1`,
      [itemId]
    );
    const row = r.rows[0];
    if (!row || row.layout_stage_id !== stageId) {
      return res.status(410).json({ erro: 'Estágio não é mais válido para este item.' });
    }

    // se o worker já subiu preview.png no staging, considera "ok"
    const keyPrev = buildStagePreviewKey(itemId, stageId);
    if (await headExists(keyPrev)) {
      return res.json({ status: 'ok', previewTempKey: keyPrev });
    }

    if (row.preview_status === 'error') {
      return res.json({ status: 'error', error: row.preview_error || 'Falha ao gerar preview.' });
    }

    return res.json({ status: 'pending' });
  } catch (e) {
    console.error('layout/stage status erro:', e);
    return res.status(500).json({ erro: 'Falha ao consultar status do estágio.' });
  }
});

// 2.1) URL temporária (assinada) do preview no STAGING
router.get('/:ordemId/itens/:itemId/layout/stage/:stageId/preview-url', requireAuth, async (req, res) => {
  try {
    const { itemId, stageId } = req.params;

    // confere se o estágio ainda é o atual do item
    const r = await db.query(
      `SELECT layout_stage_id FROM ordem_producao_uniformes_dados_modelo WHERE id = $1`,
      [itemId]
    );
    if (!r.rows[0] || r.rows[0].layout_stage_id !== stageId) {
      return res.status(410).json({ erro: 'Estágio inválido para este item.' });
    }

    const keyPrev = buildStagePreviewKey(itemId, stageId);
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: keyPrev }),
      { expiresIn: 60 * 5 }
    );
    return res.json({ url, expiresInSec: 300 });
  } catch (e) {
    console.error('layout/stage preview-url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL do preview temporário.' });
  }
});


// ===== DEV-ONLY: simula o worker gerando preview.png no staging =====
// NÃO suba isso pra produção.
if (process.env.NODE_ENV !== 'production') {
  router.post('/:ordemId/itens/:itemId/layout/stage/:stageId/mock-ok', requireAuth, async (req, res) => {
    try {
      const { itemId, stageId } = req.params;

      // checa se stage ainda é válido
      const r = await db.query(
        `SELECT layout_stage_id FROM ordem_producao_uniformes_dados_modelo WHERE id = $1`,
        [itemId]
      );
      if (!r.rows[0] || r.rows[0].layout_stage_id !== stageId) {
        return res.status(410).json({ erro: 'Estágio inválido para este item.' });
      }

      // PNG 1x1 transparente (base64)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
      const buf = Buffer.from(b64, 'base64');

      const keyPrev = buildStagePreviewKey(itemId, stageId);
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: keyPrev,
        Body: buf,
        ContentType: 'image/png',
        CacheControl: 'no-cache'
      }));

      return res.json({ ok: true, previewTempKey: keyPrev });
    } catch (e) {
      console.error('mock-ok erro:', e);
      return res.status(500).json({ erro: 'Falha ao simular preview.' });
    }
  });
}


// 3) Commit: copia do staging -> final, registra CDR e preview, limpa estágio
router.post('/:ordemId/itens/:itemId/layout/stage/:stageId/commit', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { ordemId, itemId, stageId } = req.params;
    const { fileOriginalName } = req.body || {}; // mande do front o nome original mostrado no stage

    // confere se stage é o atual
    const r = await client.query(
      `SELECT layout_stage_id FROM ordem_producao_uniformes_dados_modelo WHERE id = $1`,
      [itemId]
    );
    if (!r.rows[0] || r.rows[0].layout_stage_id !== stageId) {
      return res.status(410).json({ erro: 'Estágio inválido para este item.' });
    }

    const keyStageCdr = buildStageCdrKey(itemId, stageId, fileOriginalName || 'layout.cdr');
    const keyStagePrev = buildStagePreviewKey(itemId, stageId);

    // precisa existir preview no staging
    if (!(await headExists(keyStagePrev))) {
      return res.status(400).json({ erro: 'Preview temporário não localizado.' });
    }

    // chaves finais
    const keyFinalCdr = buildKey(ordemId, itemId, fileOriginalName || 'layout.cdr');
    const keyFinalPrev = buildPreviewKey(ordemId, itemId, 'preview.png');

    await client.query('BEGIN');

    // copia CDR
    await r2.send(new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `/${R2_BUCKET}/${keyStageCdr}`,
      Key: keyFinalCdr,
      ContentType: 'application/octet-stream'
    }));

    // soft-delete de CDRs anteriores
    await client.query(
      `UPDATE ordem_item_arquivo
          SET deleted_at = NOW()
        WHERE item_id = $1 AND deleted_at IS NULL AND key LIKE '%/corel/%'`,
      [itemId]
    );

    // registra novo CDR
    await client.query(
      `INSERT INTO ordem_item_arquivo
         (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)`,
      [
        ordemId,
        itemId,
        keyFinalCdr,
        fileOriginalName || 'layout.cdr',
        'application/octet-stream',
        null,
        req.user?.id || null,
      ]
    );

    // copia PREVIEW
    await r2.send(new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `/${R2_BUCKET}/${keyStagePrev}`,
      Key: keyFinalPrev,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    // atualiza ponteiro do preview no item
    await client.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
        SET preview_status = 'ok',
              preview_object_key = $2,
              preview_error = NULL,
              preview_updated_at = NOW(),
              layout_stage_id = NULL
        WHERE id = $1`,
      [itemId, keyFinalPrev]
    );

    // apaga staging
    try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: keyStagePrev })); } catch {}
    try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: keyStageCdr  })); } catch {}

    await client.query('COMMIT');
    return res.json({ ok: true, cdrKey: keyFinalCdr, previewKey: keyFinalPrev });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('layout/stage commit erro:', e);
    return res.status(500).json({ erro: 'Falha ao confirmar layout.' });
  } finally {
    client.release();
  }
});

// 4) Cancel: descarta staging e limpa estágio
router.post('/:ordemId/itens/:itemId/layout/stage/:stageId/cancel', requireAuth, async (req, res) => {
  try {
    const { itemId, stageId } = req.params;

    const keyStagePrev = buildStagePreviewKey(itemId, stageId);
    const keyStageCdr  = buildStageCdrKey(itemId, stageId, 'layout.cdr');

    try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: keyStagePrev })); } catch {}
    try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: keyStageCdr  })); } catch {}

    await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
          SET layout_stage_id = NULL
        WHERE id = $1 AND layout_stage_id = $2`,
      [itemId, stageId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('layout/stage cancel erro:', e);
    return res.status(500).json({ erro: 'Falha ao cancelar estágio.' });
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
