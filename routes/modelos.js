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
  const { nome, descricao, tipo_gola, tipo_manga, detalhamento_manga } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do modelo é obrigatório.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO modelos (nome, descricao, tipo_gola, tipo_manga, detalhamento_manga)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        nome.trim(),
        descricao || null,
        tipo_gola || null,
        tipo_manga || null,
        detalhamento_manga || null
      ]
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
  const { nome, descricao, tipo_gola, tipo_manga, detalhamento_manga } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome do modelo é obrigatório.' });
  }

  try {
    const result = await db.query(
      `UPDATE modelos
       SET nome = $1, descricao = $2, tipo_gola = $3, tipo_manga = $4, detalhamento_manga = $5
       WHERE id = $6
       RETURNING *`,
      [
        nome.trim(),
        descricao || null,
        tipo_gola || null,
        tipo_manga || null,
        detalhamento_manga || null,
        id
      ]
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
