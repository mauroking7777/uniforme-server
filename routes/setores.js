import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * GET /setores
 * Lista setores. Por padrão apenas ATIVOS.
 * Use ?ativos=false para trazer todos.
 * Retorna: [{ id, slug, nome, ativo }]
 */
 router.get('/', async (req, res) => {
  try {
    const ativos = req.query.ativos !== 'false'; // default: true
    const { rows } = await db.query(
      `
      SELECT id, slug, nome, ativo
      FROM public.setores
      ${ativos ? 'WHERE ativo = TRUE' : ''}
      ORDER BY ordem_exibicao NULLS LAST, nome ASC
      `
    );
    res.json(rows);
  } catch (erro) {
    console.error('Erro ao buscar setores:', erro);
    res.status(500).json({ erro: 'Erro ao buscar setores' });
  }
});

export default router;
