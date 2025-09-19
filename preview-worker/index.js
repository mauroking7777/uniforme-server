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

app.get('/health', (_, res) => res.json({ ok: true }));

// ---------- helpers ----------
function runCmd(cmd, args, timeoutSec = MAX_SEC) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; reject(new Error(`Timeout: ${cmd}`)); }, timeoutSec * 1000);
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}. ${stderr.slice(0,600)}`)); });
  });
}

async function downloadFile(url, toPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Falha ao baixar (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(toPath, buf);
}

async function inkscapeExport(inPath, outPath, mode, width) {
  const args = [
    inPath,
    '--export-type=png',
    `--export-filename=${outPath}`,
    mode === 'page' ? '--export-area-page' : '--export-area-drawing',
    `--export-width=${width}`,
    '--export-background=white',
    '--export-background-opacity=1'
  ];
  await runCmd('inkscape', args);
}

function seemsBlank(pngBuf) {
  // heurística simples: PNG *muito* pequeno costuma ser branco (ajuste se quiser)
  return pngBuf.length < 16000;
}

async function libreOfficePdf(inPath, outPdf) {
  // perfil isolado por execução (evita conflito em paralelismo)
  const profile = `file://${TMP_DIR}/lo-profile-${randomUUID()}`;
  const outDir = path.dirname(outPdf);
  await fs.mkdir(outDir, { recursive: true });
  // Converte CDR -> PDF (página 1 geralmente é o layout)
  await runCmd('soffice', [
    '--headless','--nologo','--invisible','--nodefault','--view','--nolockcheck',
    `-env:UserInstallation=${profile}`,
    '--convert-to','pdf',
    '--outdir', outDir,
    inPath
  ]);
  // LibreOffice usa o nome do arquivo como base; garantimos nome do PDF
  // Se não gerou com o mesmo nome, tentamos achar um .pdf no outDir
  try {
    await fs.access(outPdf);
  } catch {
    const base = path.basename(inPath, path.extname(inPath));
    const alt = path.join(outDir, `${base}.pdf`);
    await fs.access(alt);
    await fs.rename(alt, outPdf);
  }
}

async function pdfToPng(inPdf, outPng, width) {
  // Renderiza só a 1ª página; scale-to define largura em px
  const outPrefix = outPng.replace(/\.png$/i, '');
  await runCmd('pdftoppm', ['-png','-singlefile','-f','1','-l','1', '-scale-to', String(width), inPdf, outPrefix]);
}

// ---------- endpoint ----------
app.post('/convert', async (req, res) => {
  const { cdr_url, cdrUrl, png_put_url, width } = req.body || {};
  const sourceUrl = cdr_url || cdrUrl;
  if (!sourceUrl) return res.status(400).send('cdr_url é obrigatório');

  const W = Number(width || 1800);
  const id = randomUUID();
  const inPath  = path.join(TMP_DIR, `${id}.cdr`);
  const outPath = path.join(TMP_DIR, `${id}.png`);
  const pdfPath = path.join(TMP_DIR, `${id}.pdf`);

  let png = null;

  try {
    await downloadFile(sourceUrl, inPath);

    // 1) Inkscape (drawing)
    await inkscapeExport(inPath, outPath, 'drawing', W);
    png = await fs.readFile(outPath);

    // 2) Inkscape (page) se suspeito
    if (seemsBlank(png)) {
      await inkscapeExport(inPath, outPath, 'page', W);
      png = await fs.readFile(outPath);
    }

    // 3) LibreOffice -> PDF -> PNG se ainda suspeito
    if (seemsBlank(png)) {
      await libreOfficePdf(inPath, pdfPath);
      await pdfToPng(pdfPath, outPath, W);
      png = await fs.readFile(outPath);
    }

    // 4) upload pro R2 se mandaram URL de PUT
    if (png_put_url) {
      await fetch(png_put_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
        body: png
      });
    }

    return res.json({ ok: true, width: W, size: png.length, engine: 'inkscape|libreoffice' });
  } catch (e) {
    return res.status(422).send(String(e?.message || e));
  } finally {
    for (const p of [inPath, outPath, pdfPath]) { try { await fs.unlink(p); } catch {} }
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`preview-worker ouvindo em ${port}`));
