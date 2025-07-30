import express from 'express';
import db from '../db.js';

const router = express.Router();

// Rota para listar todos os usuários
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM usuarios');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários' });
  }
});

// Rota para cadastrar um novo usuário
router.post('/', async (req, res) => {
  const { nome, email, senha, funcao } = req.body;

  if (!nome || !email || !senha || !funcao) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    // Verifica se já existe um usuário com esse e-mail
    const existe = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);

    if (existe.rows.length > 0) {
      return res.status(409).json({ erro: 'E-mail já cadastrado.' });
    }

    // Se não existe, cadastra
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

export default router;
