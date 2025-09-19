import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

const app = express();
app.use(express.json({ limit: '50mb' }));

const MAX_SEC = Number(process.env.CONVERT_TIMEOUT_SEC || 60);
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const CC_API = process.env.CLOUDCONVERT_API_KEY || ''; // opcional (fallback)

app.get('/health', (_, res) => res.json({ ok: true }));

// util: baixa um URL para arquivo temporário
async function downloadTo(tmpPath, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Falha ao baixar (${r.status})`);
  const abuf = await r.arrayBuffer();
  await fs.writeFile(tmpPath, Buffer.from(abuf));
}

// util: roda inkscape com modo 'drawing' ou 'page'
async function runInkscape(inPath, outPath, mode, width, timeoutSec) {
  const args = [
    inPath,
    '--export-type=png',
    `--export-filename=${outPath}`,
    mode === 'page' ? '--export-area-page' : '--export-area-drawing',
    `--export-width=${width}`,
    '--export-background=white',
    '--export-background-opacity=1',
  ];
  let stderr = '';
  await new Promise((resolve, reject) => {
    const child = spawn('inkscape', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('Timeout na conversão'));
    }, (timeoutSec || MAX_SEC) * 1000);

    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Inkscape(${mode}) code=${code} ${stderr.slice(0,500)}`));
    });
  });
}

// heurística simples pra detectar “png branco/suspeito” sem libs pesadas
function seemsBlank(pngBuffer) {
  // PNG todo branco e grande costuma ficar MUITO pequeno por compressão.
  // Ajuste se necessário; 16k a 25k costuma ser um bom corte pra width~1600.
  return pngBuffer.length < 16000;
}

// fallback CloudConvert — usa só quando inkscape falha ou fica branco
async function convertViaCloudConvert(cdrUrl, width = 1600) {
  if (!CC_API) throw new Error('CLOUDCONVERT_API_KEY não configurada');
  // cria job (import -> convert -> export)
  const makeJob = await fetch('https://api.cloudconvert.com/v2/jobs', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CC_API}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tasks: {
        'import':  { operation: 'import/url', url: cdrUrl, filename: 'layout.cdr' },
        'convert': { operation: 'convert', input: 'import', input_format: 'cdr', output_format: 'png',
                     // parâmetros de saída:
                     // para vetores, "width" funciona como destino aprox.
                     // (o engine decide como encaixar; manter simples)
                     width },
        'export':  { operation: 'export/url', input: 'convert' }
      }
    })
  });
  if (!makeJob.ok) throw new Error(`CC job http ${makeJob.status}`);
  const job = await makeJob.json();
  const jobId = job?.data?.id;
  if (!jobId) throw new Error('CC: job id ausente');

  // poll até finalizar
  const start = Date.now();
  while (Date.now() - start < (MAX_SEC * 1000)) {
    await new Promise(r => setTimeout(r, 1500));
    const jr = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${CC_API}` }
    });
    if (!jr.ok) continue;
    const j = await jr.json();
    if (j?.data?.status === 'finished') {
      const exportTask = (j.data.tasks || []).find(t => t.name === 'export' && t.status === 'finished');
      const fileUrl = exportTask?.result?.files?.[0]?.url;
      if (!fileUrl) throw new Error('CC: URL de saída ausente');
      const buf = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());
      return buf;
    }
    if (j?.data?.status === 'error') throw new Error('CC: job erro');
  }
  throw new Error('CC: timeout');
}

app.post('/convert', async (req, res) => {
  const { cdr_url, cdrUrl, png_put_url, width } = req.body || {};
  const sourceUrl = cdr_url || cdrUrl;
  if (!sourceUrl) return res.status(400).send('cdr_url é obrigatório');

  const id = randomUUID();
  const inPath = path.join(TMP_DIR, `${id}.cdr`);
  const outPath = path.join(TMP_DIR, `${id}.png`);

  try {
    // 1) baixa CDR
    await downloadTo(inPath, sourceUrl);

    const W = Number(width || 1600);

    // 2) tenta inkscape (drawing)
    await runInkscape(inPath, outPath, 'drawing', W, MAX_SEC);
    let png = await fs.readFile(outPath);

    // 3) se “suspeito”, tenta inkscape (page)
    if (seemsBlank(png)) {
      await runInkscape(inPath, outPath, 'page', W, MAX_SEC);
      png = await fs.readFile(outPath);
    }

    // 4) se ainda “suspeito”, fallback CloudConvert (se configurado)
    if (seemsBlank(png) && CC_API) {
      png = await convertViaCloudConvert(sourceUrl, W);
    }

    // 5) upload direto pro R2 se mandaram PUT assinado
    if (png_put_url) {
      await fetch(png_put_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable'
        },
        body: png
      });
    }

    res.json({ ok: true, width: W, size: png.length, engine: 'auto' });
  } catch (e) {
    res.status(422).send(String(e?.message || e));
  } finally {
    try { await fs.unlink(inPath); } catch {}
    try { await fs.unlink(outPath); } catch {}
  }
});

const port = process.env.PORT || 4001;
app.listen(port, () => console.log(`preview-worker ouvindo em ${port}`));
