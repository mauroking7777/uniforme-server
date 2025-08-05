import express from 'express';
import pool from '../db.js';

const router = express.Router();

// GET - Listar todos os tamanhos de uma grade
router.get('/:grade_id', async (req, res) => {
  const { grade_id } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM tamanhos_grade WHERE grade_id = $1 ORDER BY ordem_exibicao ASC',
      [grade_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar tamanhos:', err);
    res.status(500).json({ erro: 'Erro ao buscar tamanhos' });
  }
});

// POST - Adicionar tamanho a uma grade
router.post('/', async (req, res) => {
  const { grade_id, tamanho, ordem_exibicao } = req.body;

  if (!grade_id || !tamanho) {
    return res.status(400).json({ erro: 'Grade e tamanho são obrigatórios.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tamanhos_grade (grade_id, tamanho, ordem_exibicao)
       VALUES ($1, $2, $3) RETURNING *`,
      [grade_id, tamanho, ordem_exibicao || 0]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar tamanho' });
  }
});

// PUT - Atualizar tamanho
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { tamanho, ordem_exibicao } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tamanhos_grade
       SET tamanho = $1, ordem_exibicao = $2
       WHERE id = $3
       RETURNING *`,
      [tamanho, ordem_exibicao || 0, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tamanho não encontrado.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar tamanho:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tamanho' });
  }
});

// DELETE - Remover tamanho
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM tamanhos_grade WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Tamanho não encontrado.' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir tamanho:', err);
    res.status(500).json({ erro: 'Erro ao excluir tamanho' });
  }
});

// PUT - Vincular tamanhos à grade (sincroniza: remove os antigos e insere os novos)
router.put('/vincular-grade', async (req, res) => {
  const { grade_id, tamanhos_ids } = req.body;

  if (!grade_id || !Array.isArray(tamanhos_ids)) {
    return res.status(400).json({ erro: 'grade_id e tamanhos_ids são obrigatórios.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Remove todos os tamanhos antigos da grade
    await client.query(
      `UPDATE tamanhos_grade SET grade_id = NULL WHERE grade_id = $1`,
      [grade_id]
    );

    // 2. Atribui os novos tamanhos, se houver
    if (tamanhos_ids.length > 0) {
      await client.query(
        `UPDATE tamanhos_grade SET grade_id = $1 WHERE id = ANY($2::int[])`,
        [grade_id, tamanhos_ids]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ mensagem: 'Tamanhos atualizados com sucesso.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar tamanhos da grade:', err);
    res.status(500).json({ erro: 'Erro ao atualizar tamanhos da grade.' });
  } finally {
    client.release();
  }
});

export default router;
