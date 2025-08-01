import express from 'express';
import db from '../db.js';

const router = express.Router();

// 🔍 GET - Listar todos os tipos de gola
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tipo_gola ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar tipos de gola:', err);
    res.status(500).json({ erro: 'Erro ao buscar tipos de gola.' });
  }
});

// 🟢 POST - Cadastrar novo tipo de gola
router.post('/', async (req, res) => {
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do tipo de gola é obrigatório.' });
  }

  try {
    const result = await db.query(
      'INSERT INTO tipo_gola (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar tipo de gola:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar tipo de gola.' });
  }
});

// 🟡 PUT - Atualizar tipo de gola existente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, descricao } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do tipo de gola é obrigatório.' });
  }

  try {
    const result = await db.query(
      'UPDATE tipo_gola SET nome = $1, descricao = $2 WHERE id = $3 RETURNING *',
      [nome.trim(), descricao || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tipo de gola não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar tipo de gola:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tipo de gola.' });
  }
});

// 🔴 DELETE - Excluir tipo de gola
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query('DELETE FROM tipo_gola WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tipo de gola não encontrado.' });
    }

    res.status(204).send(); // Sucesso sem conteúdo
  } catch (err) {
    console.error('Erro ao excluir tipo de gola:', err);
    res.status(500).json({ erro: 'Erro ao excluir tipo de gola.' });
  }
});

export default router;
