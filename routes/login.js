import express from 'express';
import jwt from 'jsonwebtoken';
import db from '../db.js';

const router = express.Router();
const JWT_SECRET = 'uniforme-secret-key'; // 🔐 Em breve podemos mover isso para .env

// Rota de login
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  try {
    const result = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    const usuario = result.rows[0];

    if (usuario.senha !== senha) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    // Definindo expiração do token para hoje às 23:59
    const agora = new Date();
    const expiracao = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 0);
    const tempoExpiracaoSegundos = Math.floor((expiracao - agora) / 1000);

    // Criando o token
    const token = jwt.sign(
      {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        funcao: usuario.funcao,
      },
      JWT_SECRET,
      { expiresIn: tempoExpiracaoSegundos }
    );

    // Enviando resposta
    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        funcao: usuario.funcao,
        email: usuario.email,
      },
    });
  } catch (err) {
    console.error('Erro ao realizar login:', err);
    res.status(500).json({ erro: 'Erro interno no servidor.' });
  }
});

export default router;
