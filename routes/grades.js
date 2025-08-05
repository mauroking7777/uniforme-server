import express from 'express';
import pool from '../db.js';

const router = express.Router();


// ================================
// GET - Listar todas as grades
// ================================
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM grades ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar grades:', err);
    res.status(500).json({ erro: 'Erro ao buscar grades' });
  }
});


// ===============================================
// POST - Cadastrar nova grade com tamanhos juntos
// ===============================================
router.post('/', async (req, res) => {
  const { nome, descricao, tamanhos } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome da grade é obrigatório.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Inserir a grade
    const gradeResult = await client.query(
      'INSERT INTO grades (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao || null]
    );
    const novaGrade = gradeResult.rows[0];

    // 2. Inserir os tamanhos vinculados
    if (Array.isArray(tamanhos) && tamanhos.length > 0) {
      const insertPromises = tamanhos.map((t) => {
        return client.query(
          'INSERT INTO tamanhos_grade (grade_id, tamanho, ordem_exibicao) VALUES ($1, $2, $3)',
          [novaGrade.id, t.tamanho, t.ordem_exibicao || 0]
        );
      });
      await Promise.all(insertPromises);
    }

    await client.query('COMMIT');
    res.status(201).json(novaGrade);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao cadastrar grade com tamanhos:', err);
    res.status(500).json({ erro: 'Erro ao cadastrar grade.' });
  } finally {
    client.release();
  }
});


// ================================
// PUT - Atualizar uma grade (inclui os tamanhos)
// ================================
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, descricao, tamanhos } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'O nome da grade é obrigatório.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Atualiza a grade
    const result = await client.query(
      'UPDATE grades SET nome = $1, descricao = $2 WHERE id = $3 RETURNING *',
      [nome.trim(), descricao || null, id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Grade não encontrada.' });
    }

    // Remove tamanhos antigos da grade
    await client.query('DELETE FROM tamanhos_grade WHERE grade_id = $1', [id]);

    // Insere os tamanhos novos (se houver)
    if (Array.isArray(tamanhos) && tamanhos.length > 0) {
      const insertPromises = tamanhos.map((t) =>
        client.query(
          'INSERT INTO tamanhos_grade (grade_id, tamanho, ordem_exibicao) VALUES ($1, $2, $3)',
          [id, t.tamanho, t.ordem_exibicao || 0]
        )
      );
      await Promise.all(insertPromises);
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar grade com tamanhos:', err);
    res.status(500).json({ erro: 'Erro ao atualizar grade.' });
  } finally {
    client.release();
  }
});



// ================================
// DELETE - Remover uma grade
// ================================
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM grades WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Grade não encontrada.' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir grade:', err);
    res.status(500).json({ erro: 'Erro ao excluir grade.' });
  }
});

// ✅ GET - Buscar tamanhos por grade_id
router.get('/por-grade/:gradeId', async (req, res) => {
  const { gradeId } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, tamanho, ordem_exibicao 
       FROM tamanhos_grade 
       WHERE grade_id = $1 
       ORDER BY ordem_exibicao`,
      [gradeId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar tamanhos por grade_id:', err);
    res.status(500).json({ erro: 'Erro ao buscar tamanhos.' });
  }
});


export default router;
