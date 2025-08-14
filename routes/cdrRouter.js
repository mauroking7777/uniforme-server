import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "../r2Client.js";
import db from "../db.js"; // você já tem esse
// se tiver middleware de auth, pode importar aqui: import auth from "../middlewares/auth.js";

const router = express.Router();

const MB = 1024 * 1024;
const CDR_MAX_MB = parseInt(process.env.CDR_MAX_MB || "256", 10);

// multer na memória, com limite
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CDR_MAX_MB * MB },
  fileFilter: (req, file, cb) => {
    const ok = /\.cdr$/i.test(file.originalname || "");
    if (!ok) return cb(new Error("Apenas arquivos .cdr"));
    cb(null, true);
  },
});

// POST /ordens/:ordemId/itens/:itemId/cdr/upload
router.post(
  "/:ordemId/itens/:itemId/cdr/upload",
  // opcional: auth,
  upload.single("file"),
  async (req, res) => {
    try {
      const { ordemId, itemId } = req.params;

      if (!req.file) {
        return res.status(400).json({ erro: "Envie o arquivo no campo 'file'." });
      }

      const bucket = process.env.R2_BUCKET;
      if (!bucket) {
        return res.status(500).json({ erro: "R2_BUCKET não configurado" });
      }

      // monta uma chave “bonita” no R2
      const ts = Date.now();
      const safeName = (req.file.originalname || "layout.cdr").replace(/[^\w.\-]+/g, "_");
      const objectKey = `ordens/${ordemId}/itens/${itemId}/layout/${ts}_${safeName}`;

      // faz upload para o R2
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || "application/octet-stream",
      });

      await r2.send(putCmd);

      // ===== salve no seu banco (ajuste o SQL à sua tabela real) =====
      // Exemplo genérico:
      await db.query(
        `INSERT INTO ordem_item_arquivos
           (ordem_item_id, tipo, object_key, nome_original, content_type, tamanho_bytes)
         VALUES
           ($1, 'CDR', $2, $3, $4, $5)`,
        [itemId, objectKey, req.file.originalname, req.file.mimetype, req.file.size]
      );

      return res.json({
        ok: true,
        objectKey,
        nome_original: req.file.originalname,
        tamanho_bytes: req.file.size,
      });
    } catch (err) {
      console.error("Upload CDR falhou:", err);
      const msg = err?.message || "Falha no upload";
      return res.status(500).json({ erro: msg });
    }
  }
);

export default router;
