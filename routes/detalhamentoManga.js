import express from 'express';
import db from '../db.js';

const router = express.Router();

// 🔍 GET - Listar detalhamentos de manga
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM detalhamento_manga ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar detalhamentos:', err);
    res.status(500).json({ erro: 'Erro ao buscar detalhamentos.' });
  }
});

// 🟢 POST - Cadastrar detalhamento
router.post('/', async (req, res) => {
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do detalhamento é obrigatório.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO detalhamento_manga (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar detalhamento:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar detalhamento.' });
  }
});

// 🟡 PUT - Atualizar detalhamento
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do detalhamento é obrigatório.' });
  }

  try {
    const result = await db.query(
      'UPDATE detalhamento_manga SET nome = $1, descricao = $2 WHERE id = $3 RETURNING *',
      [nome.trim(), descricao || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Detalhamento não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar detalhamento:', err);
    res.status(500).json({ erro: 'Erro ao atualizar detalhamento.' });
  }
});

// 🔴 DELETE - Excluir detalhamento
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query('DELETE FROM detalhamento_manga WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Detalhamento não encontrado.' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir detalhamento:', err);
    res.status(500).json({ erro: 'Erro ao excluir detalhamento.' });
  }
});

export default router;
