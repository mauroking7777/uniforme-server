import express from 'express';
import db from '../db.js';

const router = express.Router();

// Listar todos os modelos
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM modelos ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar modelos:', err);
    res.status(500).json({ erro: 'Erro ao buscar modelos' });
  }
});

// Cadastrar novo modelo
router.post('/', async (req, res) => {
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do modelo é obrigatório.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO modelos (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar modelo:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar modelo.' });
  }
});

// Atualizar um modelo existente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do modelo é obrigatório.' });
  }

  try {
    const result = await db.query(
      'UPDATE modelos SET nome = $1, descricao = $2 WHERE id = $3 RETURNING *',
      [nome.trim(), descricao || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar modelo:', err);
    res.status(500).json({ erro: 'Erro ao atualizar modelo.' });
  }
});

// Excluir um modelo
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query('DELETE FROM modelos WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Modelo não encontrado.' });
    }

    res.status(204).send(); // Sucesso sem conteúdo
  } catch (err) {
    console.error('Erro ao excluir modelo:', err);
    res.status(500).json({ erro: 'Erro ao excluir modelo.' });
  }
});

export default router;
