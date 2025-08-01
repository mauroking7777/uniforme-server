import express from 'express';
import pool from '../db.js';

const router = express.Router();

// 🔍 GET - Listar todos os tecidos
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tecidos ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar tecidos:', error);
    res.status(500).json({ erro: 'Erro ao buscar tecidos' });
  }
});

// 🟢 POST - Criar novo tecido
router.post('/', async (req, res) => {
  const { nome, tipo } = req.body;

  if (!nome || !tipo) {
    return res.status(400).json({ erro: 'Nome e tipo são obrigatórios.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO tecidos (nome, tipo) VALUES ($1, $2) RETURNING *',
      [nome, tipo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar tecido:', error);
    res.status(500).json({ erro: 'Erro ao criar tecido' });
  }
});

// 🟡 PUT - Atualizar tecido existente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, tipo } = req.body;

  if (!nome || !tipo) {
    return res.status(400).json({ erro: 'Nome e tipo são obrigatórios.' });
  }

  try {
    const result = await pool.query(
      'UPDATE tecidos SET nome = $1, tipo = $2 WHERE id = $3 RETURNING *',
      [nome, tipo, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tecido não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar tecido:', error);
    res.status(500).json({ erro: 'Erro ao atualizar tecido' });
  }
});

// 🔴 DELETE - Excluir tecido
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM tecidos WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tecido não encontrado.' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir tecido:', error);
    res.status(500).json({ erro: 'Erro ao excluir tecido' });
  }
});

export default router;
