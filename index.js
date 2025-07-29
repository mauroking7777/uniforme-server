import express from 'express';
import cors from 'cors';
import pool from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Servidor Uniforme.com está rodando! 🚀');
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
    res.status(500).send('Erro no banco de dados');
  }
});

// ✅ Apenas esta rota para criar a tabela
app.get('/criar-tabela', async (req, res) => {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        tipo TEXT NOT NULL,
        ativo BOOLEAN DEFAULT true,
        email_envio TEXT NOT NULL,
        senha_envio TEXT NOT NULL,
        servidor_smtp TEXT NOT NULL,
        porta_smtp INTEGER NOT NULL,
        use_ssl_tls TEXT NOT NULL,
        data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(sql);
    res.send('Tabela "usuarios" criada (ou atualizada) com sucesso!');
  } catch (err) {
    console.error('Erro ao criar tabela:', err);
    res.status(500).send('Erro ao criar a tabela');
  }
});


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
