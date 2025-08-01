import express from 'express';
import db from '../db.js';

const router = express.Router();

// 🔍 GET - Listar tipos de manga
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tipo_manga ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar tipos de manga:', err);
    res.status(500).json({ erro: 'Erro ao buscar tipos de manga.' });
  }
});

// 🟢 POST - Cadastrar tipo de manga
router.post('/', async (req, res) => {
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do tipo de manga é obrigatório.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO tipo_manga (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar tipo de manga:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar tipo de manga.' });
  }
});

// 🟡 PUT - Atualizar tipo de manga
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do tipo de manga é obrigatório.' });
  }

  try {
    const result = await db.query(
      'UPDATE tipo_manga SET nome = $1, descricao = $2 WHERE id = $3 RETURNING *',
      [nome.trim(), descricao || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tipo de manga não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar tipo de manga:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tipo de manga.' });
  }
});

// 🔴 DELETE - Excluir tipo de manga
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query('DELETE FROM tipo_manga WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tipo de manga não encontrado.' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir tipo de manga:', err);
    res.status(500).json({ erro: 'Erro ao excluir tipo de manga.' });
  }
});

export default router;
