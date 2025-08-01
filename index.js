import express from 'express';
import cors from 'cors';
import pool from './db.js'; // conexão com o banco
import rotaUsuarios from './routes/usuarios.js';
import rotaFuncoes from './routes/funcoes.js';
import rotaModelos from './routes/modelos.js';
import tecidosRoutes from './tecidos.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/usuarios', rotaUsuarios);
app.use('/funcoes', rotaFuncoes);
app.use('/modelos', rotaModelos);
app.use('/tecidos', tecidosRoutes);

// Rota raiz para verificação do servidor
app.get('/', (req, res) => {
  res.send('Servidor Uniforme.com está rodando! 🚀');
});

// Rota de teste para verificar conexão com o banco
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
    res.status(500).send('Erro no banco de dados');
  }
});

// Rota opcional para criação da tabela usuarios (pode ser mantida para emergências)
app.get('/criar-tabela', async (req, res) => {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        funcao TEXT NOT NULL,
        ativo BOOLEAN DEFAULT true,
        email_envio TEXT NOT NULL,
        senha_envio TEXT NOT NULL,
        servidor_smtp TEXT NOT NULL,
        porta_smtp INTEGER NOT NULL,
        use_ssl_tls TEXT NOT NULL,
        data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await pool.query(sql);
    res.send('Tabela "usuarios" criada (ou atualizada) com sucesso!');
  } catch (err) {
    console.error('Erro ao criar tabela:', err);
    res.status(500).send('Erro ao criar a tabela');
  }
});



// Inicializa servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
