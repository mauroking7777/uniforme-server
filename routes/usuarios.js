import express from 'express';
import db from '../db.js';

const router = express.Router();

// Listar todos os usuários
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários' });
  }
});

// Cadastrar um novo usuário
router.post('/', async (req, res) => {
  const { nome, email, senha, funcao } = req.body;

  if (!nome || !email || !senha || !funcao) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    const existe = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);

    if (existe.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado.' });
    }

    const resultado = await db.query(
      `INSERT INTO usuarios (nome, email, senha, funcao, ativo, data_cadastro)
       VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
       RETURNING *`,
      [nome, email, senha, funcao]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar usuário:', err);
    res.status(500).json({ erro: 'Erro interno ao cadastrar usuário.' });
  }
});

// ✅ Buscar os acessos de um usuário
router.get('/:id/acessos', async (req, res) => {
  const { id } = req.params;

  try {
    const resultado = await db.query(
      `
      SELECT s.id, s.nome
      FROM acessos_usuario au
      JOIN setores s ON s.id = au.setor_id
      WHERE au.usuario_id = $1
      ORDER BY s.nome
      `,
      [id]
    );

    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar acessos do usuário:', erro);
    res.status(500).json({ erro: 'Erro ao buscar acessos do usuário' });
  }
});

// ✅ Salvar (ou atualizar) os acessos de um usuário
router.post('/:id/acessos', async (req, res) => {
  const { id } = req.params;
  const { setores } = req.body; // array de IDs

  if (!Array.isArray(setores)) {
    return res.status(400).json({ erro: 'O campo "setores" deve ser um array de IDs.' });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Remove acessos anteriores
    await client.query('DELETE FROM acessos_usuario WHERE usuario_id = $1', [id]);

    // Insere os novos
    for (const setorId of setores) {
      await client.query(
        'INSERT INTO acessos_usuario (usuario_id, setor_id) VALUES ($1, $2)',
        [id, setorId]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ mensagem: 'Acessos atualizados com sucesso.' });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar acessos:', erro);
    res.status(500).json({ erro: 'Erro ao atualizar acessos.' });
  } finally {
    client.release();
  }
});

export default router;
