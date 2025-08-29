// cloudconvertService.js
import CloudConvert from 'cloudconvert';
import crypto from 'crypto';
import db from './db.js';
import { r2GetSignedUrl, r2PutObject } from './routes/r2Client.js';

const { CLOUDCONVERT_API_KEY, R2_PREVIEWS_PREFIX } = process.env;

// prefixo onde salvaremos os PNGs no R2
function previewsPrefix() {
  const p = R2_PREVIEWS_PREFIX || 'previews';
  return p.replace(/^\/+|\/+$/g, '');
}

// URL de download temporária (GET) para um objeto do R2
async function presignGet(objectKey, expiresSeconds = 900) {
  return r2GetSignedUrl('GET', objectKey, expiresSeconds);
}

// Upload de buffer para o R2 (PNG)
async function uploadToR2(objectKey, buffer, contentType = 'image/png') {
  await r2PutObject(objectKey, buffer, contentType);
}

/**
 * Dispara a conversão de um CDR -> PNG via CloudConvert
 * - gera URL assinada (GET) do CDR no R2
 * - cria job no CloudConvert (import -> convert -> export)
 * - baixa o PNG gerado
 * - sobe no R2 em previews/<ordemId>/<itemId>/<hash>.png
 * - marca o item como 'ready' | 'failed'
 */
export async function startPreviewGeneration({ ordemId, itemId, cdrObjectKey }) {
  if (!CLOUDCONVERT_API_KEY) throw new Error('CLOUDCONVERT_API_KEY não configurada');

  // marca como pending no BD
  await db.query(
    `UPDATE public.ordem_producao_uniformes_dados_modelo
        SET preview_status = 'pending',
            preview_error = NULL,
            preview_updated_at = NOW()
      WHERE id = $1`,
    [itemId]
  );

  const cloudConvert = new CloudConvert(CLOUDCONVERT_API_KEY);

  try {
    // 1) URL de leitura temporária do CDR armazenado no R2
    const signedUrl = await presignGet(cdrObjectKey, 900);

    // 2) Cria o job (import -> convert -> export)
    const job = await cloudConvert.jobs.create({
      tasks: {
        import_cdr: {
          operation: 'import/url',
          url: signedUrl,
        },
        convert_png: {
          operation: 'convert',
          input: 'import_cdr',
          output_format: 'png',
          // parâmetros adicionais podem ser ajustados depois (dpi, background, etc.)
        },
        export_png: {
          operation: 'export/url',
          input: 'convert_png',
        },
      },
    });

    // 3) Espera finalizar
    const completed = await cloudConvert.jobs.wait(job.id);

    // 4) Pega o arquivo exportado
    const exportTask = completed.tasks.find(
      (t) => t.name === 'export_png' && t.status === 'finished'
    );
    if (!exportTask || !exportTask.result?.files?.length) {
      throw new Error('Conversão não retornou arquivo exportado.');
    }

    const file = exportTask.result.files[0]; // { filename, url, size, ... }
    const downloadUrl = file.url;

    // 5) Baixa o PNG gerado
    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Falha ao baixar PNG do CloudConvert: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());

    // 6) Envia o PNG ao R2
    const hash = crypto
      .createHash('md5')
      .update(String(Date.now()) + (file.filename || ''))
      .digest('hex')
      .slice(0, 10);

    const pngKey = `${previewsPrefix()}/${ordemId}/${itemId}/${hash}.png`;
    await uploadToR2(pngKey, buffer, 'image/png');

    // 7) Marca como pronto
    await db.query(
      `UPDATE public.ordem_producao_uniformes_dados_modelo
          SET preview_status = 'ready',
              preview_object_key = $2,
              preview_error = NULL,
              preview_updated_at = NOW()
        WHERE id = $1`,
      [itemId, pngKey]
    );
  } catch (err) {
    // marca como failed
    await db.query(
      `UPDATE public.ordem_producao_uniformes_dados_modelo
          SET preview_status = 'failed',
              preview_error = $2,
              preview_updated_at = NOW()
        WHERE id = $1`,
      [itemId, String(err?.message || err)]
    );
    console.error('[cloudconvert] erro ao gerar preview:', err);
  }
}
