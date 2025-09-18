import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

const app = express();
app.use(express.json({ limit: '50mb' }));

// Ajustes
const MAX_SEC = Number(process.env.CONVERT_TIMEOUT_SEC || 60); // timeout por conversão
const TMP_DIR = process.env.TMP_DIR || '/tmp';                  // diretório temporário

app.get('/health', (_, res) => res.json({ ok: true })); // healthcheck simples

// POST /convert  { cdrUrl: <URL assinado>, width?: number }
app.post('/convert', async (req, res) => {
  const { cdrUrl, width } = req.body || {};
  if (!cdrUrl) return res.status(400).send('cdrUrl é obrigatório');

  const id = randomUUID();
  const inPath = path.join(TMP_DIR, `${id}.cdr`);
  const outPath = path.join(TMP_DIR, `${id}.png`);

  try {
    // 1) Baixa o CDR
    const r = await fetch(cdrUrl);
    if (!r.ok) return res.status(400).send(`Falha ao baixar CDR: ${r.status}`);
    const abuf = await r.arrayBuffer();
    await fs.writeFile(inPath, Buffer.from(abuf));

    // 2) Converte com Inkscape headless
    const args = [
      inPath,
      '--export-type=png',
      `--export-filename=${outPath}`,
      `--export-width=${Number(width) || 3000}`,
      '--export-background-opacity=0'
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
        else reject(new Error(`Inkscape saiu com código ${code}. STDERR: ${stderr.slice(0,500)}`));
      });
    });

    // 3) Devolve PNG base64
    const png = await fs.readFile(outPath);
    res.json({ pngBase64: png.toString('base64') });
  } catch (e) {
    res.status(422).send(String(e?.message || e));
  } finally {
    try { await fs.unlink(inPath); } catch {}
    try { await fs.unlink(outPath); } catch {}
  }
});

const port = process.env.PORT || 4001;
app.listen(port, () => console.log(`preview-worker ouvindo em ${port}`));
