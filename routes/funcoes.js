import express from 'express';
import db from '../db.js';

const router = express.Router();

// Listar todas as funções
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM funcoes ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar funções:', err);
    res.status(500).json({ erro: 'Erro ao buscar funções' });
  }
});

// Cadastrar nova função
router.post('/', async (req, res) => {
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome da função é obrigatório.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO funcoes (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar função:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar função.' });
  }
});

export default router;
