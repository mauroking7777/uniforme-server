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
 * PREVIEW (PNG/JPG) — upload direto pelo front
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

// 2) CONFIRM do PREVIEW (registra a chave e marca como READY)
router.post('/:ordemId/itens/:itemId/preview/confirm', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { objectKey, nome_arquivo, content_type, tamanho_bytes } = req.body || {};

    // 1) Consistência básica
    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!objectKey) {
      return res.status(400).json({ erro: 'objectKey é obrigatório.' });
    }

// 2) Valida caminho e extensão (png/jpg/jpeg)
const keyStr = String(objectKey);

const pathOK =
  keyStr.includes(`ordens/${ordemId}/itens/${itemId}/previews/`) || // sem barra inicial (como o backend gera)
  keyStr.includes(`/ordens/${ordemId}/itens/${itemId}/previews/`);  // aceita também com barra inicial

const isPng = /\.png$/i.test(keyStr);
const isJpg = /\.(jpg|jpeg)$/i.test(keyStr);

if (!pathOK || !(isPng || isJpg)) {
  return res.status(400).json({ erro: 'objectKey inválido para preview.' });
}


    // 3) Atualiza o item com a chave e marca READY
    await db.query(
      `UPDATE ordem_producao_uniformes_dados_modelo
          SET preview_object_key = $1,
              preview_status = 'ready',
              preview_error = NULL,
              preview_updated_at = NOW()
        WHERE id = $2`,
      [objectKey, itemId]
    );

    // (opcional) você pode guardar meta (nome, type, size) em colunas próprias no futuro
    return res.json({
      ok: true,
      objectKey,
      meta: {
        nome_arquivo: nome_arquivo || null,
        content_type: content_type || null,
        tamanho_bytes: Number(tamanho_bytes) || null,
      }
    });
  } catch (e) {
    console.error('preview confirm erro:', e);
    return res.status(500).json({ erro: 'Falha ao confirmar preview.' });
  }
});


// 3) URL do PREVIEW mais recente (assina GET no R2)
// 200: { url } se pronto; 202: pendente; 404: não há preview
router.get('/:ordemId/itens/:itemId/preview/url', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;

    // Busca status e chave do preview no item
    const q = await db.query(
      `SELECT preview_status, preview_object_key
         FROM ordem_producao_uniformes_dados_modelo
        WHERE id = $1 AND ordem_id = $2
        LIMIT 1`,
      [itemId, ordemId]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ erro: 'Item não encontrado.' });
    }

    const { preview_status, preview_object_key } = q.rows[0];

    if (preview_status === 'pending') {
      return res.status(202).json({ status: 'pending' });
    }
    if (!preview_object_key) {
      return res.status(404).json({ erro: 'Sem preview para este item.' });
    }

    // assina GET no R2
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: preview_object_key,
      }),
      { expiresIn: 60 * 10 }
    );

    return res.json({ url, expiresInSec: 600 });
  } catch (e) {
    console.error('preview url erro:', e);
    return res.status(500).json({ erro: 'Falha ao gerar URL do preview.' });
  }
});


/* =========================================================
 * CDR (upload via multipart OU via presigned PUT)
 * ========================================================= */

// 3) Upload direto do CDR (multipart)
router.post(
  '/:ordemId/itens/:itemId/cdr/upload',
  requireAuth,
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'lista_nomes', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { ordemId, itemId } = req.params;

      if (!(await assertItemDaOrdem(ordemId, itemId))) {
        return res.status(400).json({ error: 'Item não pertence à ordem informada.' });
      }

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

      // sobe o CDR
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

      // lista (opcional)
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

      return res.json({
        ok: true,
        cdr: { id: insCdr.rows[0].id, key: keyCdr },
        lista: listaSaved,
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

// 4) Presigned PUT para CDR (front faz o PUT) 
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

// 5) Confirma o CDR após o PUT (registra no BD)
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

// 5.1) Salvar LISTA DE NOMES (JSON) via POST (criação/edição)
router.post('/:ordemId/itens/:itemId/lista-nomes', requireAuth, async (req, res) => {
  try {
    const { ordemId, itemId } = req.params;
    const { lista, modelo_codigo } = req.body || {};

    if (!(await assertItemDaOrdem(ordemId, itemId))) {
      return res.status(400).json({ erro: 'Item não pertence à ordem informada.' });
    }
    if (!Array.isArray(lista) || lista.length === 0) {
      return res.status(400).json({ erro: 'Parâmetro "lista" inválido (array vazio).' });
    }

    // monta payload JSON (você pode adicionar mais metadados se quiser)
    const payloadObj = { lista, modelo_codigo: modelo_codigo || null };
    const payload = JSON.stringify(payloadObj);
    const buf = Buffer.from(payload, 'utf8');

    // chave no R2
    const keyLista = buildListKey(ordemId, itemId);

    // sobe para o R2
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: keyLista,
      Body: buf,
      ContentType: 'application/json; charset=utf-8',
      ContentLength: buf.byteLength,
      CacheControl: 'private, max-age=0, no-cache',
    }));

    // soft-delete das listas anteriores deste item
    await db.query(
      `UPDATE ordem_item_arquivo
         SET deleted_at = NOW()
       WHERE item_id = $1
         AND deleted_at IS NULL
         AND key LIKE '%/listas/%'`,
      [itemId]
    );

    // registra no banco
    const { rows } = await db.query(
      `INSERT INTO ordem_item_arquivo
         (ordem_id, item_id, key, nome_original, content_type, tamanho_bytes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7)
       RETURNING id, key, created_at`,
      [
        ordemId,
        itemId,
        keyLista,
        'lista-nomes.json',
        'application/json',
        buf.byteLength,
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ ok: true, arquivo: rows[0] });
  } catch (e) {
    console.error('lista-nomes POST erro:', e);
    return res.status(500).json({ erro: 'Falha ao salvar a lista de nomes.' });
  }
});


/* =========================================================
 * LISTAGEM / DOWNLOAD / DELETE
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
