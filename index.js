// index.js
import express from 'express';
import cors from 'cors';
import pool from './db.js';
import 'dotenv/config';

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
import rotaSetores from './routes/setores.js';

// Auth / login
import loginRoutes from './routes/login.js';

// Ordens de produção (uniformes)
import ordemProducaoUniformeRouter from './routes/ordemProducaoUniformeRouter.js';
import ordemProducaoUniformeModelosRouter from './routes/ordemProducaoUniformeModelosRouter.js';
import ordemProducaoUniformeTamanhosRouter from './routes/ordemProducaoUniformeTamanhosRouter.js';

// Upload de arquivos dos itens da ordem (CDR / lista / preview direto)
import ordemItemArquivoRouter from './routes/ordemItemArquivoRouter.js';
import extractListRouter from './routes/extractListRouter.js';

// Setores da ordem e painéis
import ordemSetoresRouter from './routes/ordemProducaoUniformeSetoresRouter.js';
import setoresImpressaoOrdensRouter from './routes/setoresImpressaoOrdensRouter.js';
import setorConfiguracaoRouter from './routes/setorConfiguracaoRouter.js';

// Envio da ordem
import rotaEnvio from './routes/ordemEnvioRouter.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// limite de 5mb para payload JSON (seguro para respostas do GPT)
app.use(express.json({ limit: '5mb' }));

/* ========= Auth / base ========= */
app.use('/', loginRoutes);

/* ========= Cadastros ========= */
app.use('/usuarios', rotaUsuarios);
app.use('/setores', rotaSetores);
app.use('/funcoes', rotaFuncoes);
app.use('/modelos', rotaModelos);
app.use('/tecidos', tecidosRoutes);
app.use('/tipo-gola', rotaTipoGola);
app.use('/tipo-manga', rotaTipoManga);
app.use('/detalhamento-manga', rotaDetalhamentoManga);
app.use('/grades', rotaGrades);
app.use('/extract-list', extractListRouter);

// Tamanhos da grade
app.use('/tamanhos-grade', rotaTamanhosGrade);

/* ========= Ordens (uniformes) ========= */
app.use(ordemProducaoUniformeRouter);
app.use(ordemProducaoUniformeModelosRouter);
app.use(ordemProducaoUniformeTamanhosRouter);

// ✅ Sem prefixo: mantém as rotas exatamente como o front chama (/ordens/…)
app.use('/', ordemItemArquivoRouter);

// Setores / painéis / envio
app.use('/', ordemSetoresRouter);
app.use('/', setoresImpressaoOrdensRouter);
app.use('/', setorConfiguracaoRouter);
app.use('/', rotaEnvio);

/* ========= Saúde ========= */
app.get('/', (req, res) => {
  res.send('Servidor Uniforme.com está rodando! 🚀');
});

// Diagnóstico opcional
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
    res.status(500).send('Erro no banco de dados');
  }
});

// (fallback) — se essa rota já existir em routes/tamanhosGrade.js, remova este bloco
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
