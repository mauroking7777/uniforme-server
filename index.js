// index.js
import express from 'express';
import cors from 'cors';
import pool from './db.js';

// Cadastros / catálogo
import rotaUsuarios from './routes/usuarios.js';
import rotaFuncoes from './routes/funcoes.js';
import rotaModelos from './routes/modelos.js';
import tecidosRoutes from './routes/tecidos.js';
import rotaTipoGola from './routes/tipoGola.js';
import rotaTipoManga from './routes/tipoManga.js';
import rotaDetalhamentoManga from './routes/detalhamentoManga.js';
import rotaGrades from './routes/grades.js';
import rotaTamanhosGrade from './routes/tamanhosGrade.js';
// ⚠️ REMOVIDO o import duplicado:  import tamanhosGradeRouter from './routes/tamanhosGrade.js';
import rotaSetores from './routes/setores.js';

// Auth / login
import loginRoutes from './routes/login.js';

// Ordens de produção (uniformes)
import ordemProducaoUniformeRouter from './routes/ordemProducaoUniformeRouter.js';
import ordemProducaoUniformeModelosRouter from './routes/ordemProducaoUniformeModelosRouter.js';
import ordemProducaoUniformeTamanhosRouter from './routes/ordemProducaoUniformeTamanhosRouter.js';

// Upload de arquivos dos itens da ordem (CDR)
import ordemItemArquivoRouter from './routes/ordemItemArquivoRouter.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Auth / base
app.use('/', loginRoutes);

// Cadastros
app.use('/usuarios', rotaUsuarios);
app.use('/setores', rotaSetores);
app.use('/funcoes', rotaFuncoes);
app.use('/modelos', rotaModelos);
app.use('/tecidos', tecidosRoutes);
app.use('/tipo-gola', rotaTipoGola);
app.use('/tipo-manga', rotaTipoManga);
app.use('/detalhamento-manga', rotaDetalhamentoManga);
app.use('/grades', rotaGrades);

// Tamanhos da grade (MONTAR APENAS UMA VEZ)
app.use('/tamanhos-grade', rotaTamanhosGrade);

// Ordens (uniformes)
app.use(ordemProducaoUniformeRouter);
app.use(ordemProducaoUniformeModelosRouter);
app.use(ordemProducaoUniformeTamanhosRouter);

// 🔴 PULO DO GATO: prefixo /ordens para casar com o front
// O arquivo routes/ordemItemArquivoRouter.js deve declarar rotas RELATIVAS, tipo:
// router.post('/:ordemId/itens/:itemId/cdr/upload', upload.single('file'), handler)
app.use('/ordens', ordemItemArquivoRouter);

// Saúde
app.get('/', (req, res) => {
  res.send('Servidor Uniforme.com está rodando! 🚀');
});

// Diagnóstico opcional (você já tinha)
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
    res.status(500).send('Erro no banco de dados');
  }
});

// Rota opcional de criação de tabela (mantenha só se precisar mesmo)
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

// Se essa rota já estiver dentro do router de tamanhosGrade, remova daqui.
// Mantive para não quebrar seu fluxo atual.
app.get('/tamanhos-grade/por-grade/:grade_id', async (req, res) => {
  const { grade_id } = req.params;
  try {
    const resultado = await pool.query(
      'SELECT id, tamanho, ordem_exibicao FROM tamanhos_grade WHERE grade_id = $1 ORDER BY ordem_exibicao ASC',
      [grade_id]
    );
    res.json(resultado.rows);
  } catch (erro) {
    console.error('Erro ao buscar tamanhos da grade:', erro);
    res.status(500).json({ erro: 'Erro ao buscar tamanhos da grade' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
