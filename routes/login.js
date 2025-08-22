import express from 'express';
import jwt from 'jsonwebtoken';
import db from '../db.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'uniforme-secret-key';

// Rota de login
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  try {
    const result = await db.query('SELECT * FROM public.usuarios WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    const usuario = result.rows[0];

    if (usuario.senha !== senha) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    // Buscar acessos do usuário (somente setores ativos; traz slug também)
    const acessosQuery = await db.query(
      `
      SELECT s.id, s.slug, s.nome
      FROM public.acessos_usuario au
      JOIN public.setores s ON s.id = au.setor_id
      WHERE au.usuario_id = $1
        AND s.ativo = TRUE
      ORDER BY s.ordem_exibicao NULLS LAST, s.nome ASC
      `,
      [usuario.id]
    );
    
    const acessos       = acessosQuery.rows.map(a => a.nome); // compatível com o front
    const acessos_slugs = acessosQuery.rows.map(a => a.slug); // futuro
    const acessos_ids   = acessosQuery.rows.map(a => a.id);

    // Gera token com expiração 23:59 do dia
    const agora = new Date();
    const expiracao = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 0);
    const tempoExpiracaoSegundos = Math.floor((expiracao - agora) / 1000);

    const token = jwt.sign(
      {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        funcao: usuario.funcao,
        acessos,       // mantém compatível
        acessos_slugs, // extra
      },
      JWT_SECRET,
      { expiresIn: tempoExpiracaoSegundos }
    );

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        funcao: usuario.funcao,
        email: usuario.email,
        acessos,        // nomes (ex.: "Impressão")
        acessos_slugs,  // slugs (ex.: "impressao")
        acessos_ids,    // ids numéricos
      },
    });
  } catch (err) {
    console.error('Erro ao realizar login:', err);
    res.status(500).json({ erro: 'Erro interno no servidor.' });
  }
});

export default router;
