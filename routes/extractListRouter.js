// routes/extractListRouter.js
import express from 'express';
import multer from 'multer';
import { extractWithVision } from './visionProvider.js'; // << AQUI

const router = express.Router();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const hasFile = Boolean(req.file);
    const text = (req.body?.text || '').toString();

    if (!hasFile && !text.trim()) {
      return res.status(400).json({ error: 'Envie um arquivo (file) ou o campo text.' });
    }

    const result = await extractWithVision({
      buffer: req.file?.buffer || null,
      mimetype: req.file?.mimetype || null,
      textFallback: text || null
    });

    res.json(result);
  } catch (err) {
    console.error('extract-list error:', err);
    res.status(500).json({ error: 'Falha ao processar lista', details: String(err.message || err) });
  }
});

export default router;
