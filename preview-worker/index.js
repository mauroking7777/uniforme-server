import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

// Em Node >=18 fetch já é global; se quiser garantir em versões antigas, instale node-fetch e descomente:
// import fetch from 'node-fetch';

const app = express();

// Aceita JSON (para receber { cdrUrl, width, mode }) e binário bruto (CDR em octet-stream)
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '200mb' }));

// ===== Config =====
const MAX_SEC = Number(process.env.CONVERT_TIMEOUT_SEC || 60); // timeout por conversão
const TMP_DIR = process.env.TMP_DIR || '/tmp';                  // diretório temporário padrão
const DEFAULT_WIDTH = Number(process.env.DEFAULT_PREVIEW_W || 2000); // largura padrão do PNG

app.get('/health', (_, res) => res.json({ ok: true }));

/**
 * POST /convert
 * 1) Modo JSON:  Content-Type: application/json
 *    body: { cdrUrl: string, width?: number, mode?: 'drawing'|'page' }
 *
 * 2) Modo binário: Content-Type: application/octet-stream (body = arquivo CDR)
 *    querystring opcional: ?w=2000&mode=drawing
 */
app.post('/convert', async (req, res) => {
  // fontes de config (query > body > defaults)
  const qsW = req.query.w && Number(req.query.w);
  const bodyW = (req.body && typeof req.body === 'object') ? Number(req.body.width) : undefined;
  const width = clampNumber(qsW || bodyW || DEFAULT_WIDTH, 300, 6000);

  const qsMode = (typeof req.query.mode === 'string' ? req.query.mode : '').toLowerCase();
  const bodyMode = (req.body && typeof req.body === 'object' && typeof req.body.mode === 'string')
    ? req.body.mode.toLowerCase()
    : undefined;
  const mode = (qsMode === 'page' || bodyMode === 'page') ? 'page' : 'drawing'; // default = drawing

  const id = randomUUID();
  const inPath = path.join(TMP_DIR, `${id}.cdr`);
  const outPath = path.join(TMP_DIR, `${id}.png`);

  let needCleanupIn = false;
  let needCleanupOut = false;

  try {
    await fs.mkdir(TMP_DIR, { recursive: true });

    // 1) Obter o CDR (binário bruto OU via URL assinada)
    if (req.is('application/octet-stream')) {
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).send('Body vazio (octet-stream) não recebido.');
      }
      await fs.writeFile(inPath, req.body);
      needCleanupIn = true;
    } else {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const cdrUrl = body.cdrUrl;
      if (!cdrUrl) return res.status(400).send('cdrUrl é obrigatório (JSON) ou envie o CDR como application/octet-stream.');
      const r = await fetch(cdrUrl);
      if (!r.ok) return res.status(400).send(`Falha ao baixar CDR: HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      await fs.writeFile(inPath, Buffer.from(ab));
      needCleanupIn = true;
    }

    // 2) Inkscape headless -> PNG
    const args = [
      inPath,
      '--export-type=png',
      `--export-filename=${outPath}`,
      mode === 'page' ? '--export-area-page' : '--export-area-drawing',
      `--export-width=${width}`,
      '--export-background=white',
      '--export-background-opacity=1',
    ];

    const child = spawn('inkscape', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', d => (stderr += d.toString()));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('Timeout na conversão'));
      }, MAX_SEC * 1000);

      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Inkscape saiu com código ${code}. STDERR: ${stderr.slice(0, 600)}`));
      });
    });

    // 3) Responder PNG em base64 (para exibir no modal)
    const png = await fs.readFile(outPath);
    needCleanupOut = true;
    res.json({ pngBase64: png.toString('base64'), width, mode });
  } catch (e) {
    res.status(422).send(String(e?.message || e));
  } finally {
    if (needCleanupIn) { try { await fs.unlink(inPath); } catch {} }
    if (needCleanupOut) { try { await fs.unlink(outPath); } catch {} }
  }
});

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`preview-worker ouvindo em ${port}`));
