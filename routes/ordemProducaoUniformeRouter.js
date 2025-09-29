import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';


const router = express.Router();

// Criar nova ordem de produção de uniformes
router.post('/ordens-uniformes', async (req, res) => {
  const {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    usuario_id,
    tipo_ordem
  } = req.body;

  if (!numero_ordem || !data_entrada || !cliente || !usuario_id) {
    return res.status(400).json({
      erro: 'Campos obrigatórios faltando.',
      camposObrigatorios: ['numero_ordem', 'data_entrada', 'cliente', 'usuario_id'],
      dadosRecebidos: {
        numero_ordem,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        usuario_id,
        tipo_ordem
      }
    });
  }

  try {
    const nova = await db.query(
      `INSERT INTO ordem_producao_uniformes_dados_ordem
        (numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, status, usuario_id, tipo_ordem)
       VALUES ($1, $2, $3, $4, $5, 'rascunho', $6, $7)
       RETURNING *`,
      [numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, usuario_id, tipo_ordem]
    );

    res.status(201).json(nova.rows[0]);
  } catch (err) {
    res.status(500).json({
      erro: 'Erro ao criar ordem.',
      detalhes: err.message,
      dadosRecebidos: {
        numero_ordem,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        usuario_id,
        tipo_ordem
      }
    });
  }
});

// POST /ordens-uniformes/:id/enviar
// [REMOVIDO] rota duplicada de envio; usar routes/ordemEnvioRouter.js como canônica.

// Listar todas as ordens
router.get('/ordens-uniformes', async (req, res) => {
  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem ORDER BY id DESC'
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar ordens.' });
  }
});

// Buscar uma ordem específica
router.get('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem WHERE id = $1',
      [id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada.' });
    }

    res.json(resultado.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordem.' });
  }
});

// Atualizar ordem (auto salvamento)
router.put('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  const {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    status,
    usuario_id,
    tipo_ordem
  } = req.body;

  try {
    const resultado = await db.query(
      `UPDATE ordem_producao_uniformes_dados_ordem
          SET numero_ordem = $1,
              data_entrada = $2,
              prazo_entrega = $3,
              data_entrega = $4,
              cliente = $5,
              status = $6,
              usuario_id = $7,
              tipo_ordem = $8
        WHERE id = $9
      RETURNING *`,
      [
        numero_ordem,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        status,
        usuario_id,
        tipo_ordem,
        id
      ]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Ordem não encontrada para atualizar.' });
    }

    res.json(resultado.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar ordem.', detalhes: err.message });
  }
});

// Deletar ordem
router.delete('/ordens-uniformes/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM ordem_producao_uniformes_dados_ordem WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar ordem.' });
  }
});

// Buscar ordens por usuário (A) — manteremos apenas UMA depois (ver passo futuro)
router.get('/ordens-uniformes/usuario/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await db.query(
      `SELECT *
         FROM ordem_producao_uniformes_dados_ordem
        WHERE usuario_id = $1
        ORDER BY id DESC`,
      [id]
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordens por usuário.' });
  }
});

// Buscar ordens por usuário (B) — rota redundante a ser unificada em passo futuro
router.get('/ordens-uniformes/usuario/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;
  try {
    const resultado = await db.query(
      `SELECT *
         FROM ordem_producao_uniformes_dados_ordem
        WHERE usuario_id = $1
        ORDER BY id DESC`,
      [usuario_id]
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordens por usuário.' });
  }
});

// Lista de setores (atalho)
router.get('/setores', async (req, res) => {
  try {
    const ativos = req.query.ativos !== 'false'; // default: true
    const { rows } = await db.query(
      `
      SELECT id, slug, nome, ativo
      FROM public.setores
      ${ativos ? 'WHERE ativo = TRUE' : ''}
      ORDER BY ordem_exibicao NULLS LAST, nome ASC
      `
    );
    res.json(rows);
  } catch (erro) {
    console.error('Erro ao buscar setores:', erro);
    res.status(500).json({ erro: 'Erro ao buscar setores' });
  }
});

export default router;
