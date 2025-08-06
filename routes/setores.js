import express from 'express';
import db from '../db.js';

const router = express.Router();

// Listar todos os setores
router.get('/', async (req, res) => {
  try {
    const resultado = await db.query('SELECT id, nome FROM setores ORDER BY nome');
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar setores:', erro);
    res.status(500).json({ erro: 'Erro ao buscar setores' });
  }
});

export default router;
