import express from 'express';
import db from '../db.js';
import { auth as requireAuth } from './auth.js';

// Para ler JSON da lista no R2
import { r2 } from './r2Client.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const router = express.Router();

/* =========================
   Helpers
========================= */

// Verifica duplicidade do número da ordem
async function numeroOrdemDuplicado(numero, ignoreId = null) {
  const sql = `
    SELECT 1
      FROM ordem_producao_uniformes_dados_ordem
     WHERE numero_ordem = $1
       AND ($2::int IS NULL OR id <> $2::int)
     LIMIT 1`;
  const r = await db.query(sql, [String(numero || '').trim(), ignoreId]);
  return r.rowCount > 0;
}

// Lê um objeto JSON do R2
async function readR2ObjectAsJson(objectKey) {
  if (!objectKey) return null;
  const { R2_BUCKET } = process.env;
  const resp = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
  const buf = await resp.Body.transformToByteArray();
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

// Soma quantidades por tamanho da GRADE por item (modelo)
async function carregarMapaGradePorItem(ordemId) {
  const sql = `
    SELECT m.id AS item_id,
    COALESCE(tg.tamanho, '') AS tamanho,

           COALESCE(oti.quantidade, 0) AS quantidade
      FROM ordem_producao_uniformes_dados_modelo m
 LEFT JOIN ordem_producao_uniformes_tamanhos_item oti ON oti.modelo_id = m.id
 LEFT JOIN tamanhos_grade tg ON tg.id = oti.tamanho_id
     WHERE m.ordem_id = $1
  `;
  const { rows } = await db.query(sql, [ordemId]);
  const mapa = new Map(); // Map<itemId, Map<tamanho, qtd>>
  for (const r of rows) {
    const itemId = r.item_id;
    if (!mapa.has(itemId)) mapa.set(itemId, new Map());
    const m = mapa.get(itemId);
    const key = String(r.tamanho || '').trim().toUpperCase();
    m.set(key, (m.get(key) || 0) + (parseInt(r.quantidade, 10) || 0));
  }
  return mapa;
}

// Soma quantidades por tamanho da LISTA de nomes por item (modelo)
async function carregarMapaListaPorItem(ordemId) {
  // pega o último JSON (lista) de cada item
  const { rows } = await db.query(`
  SELECT a.item_id,
         a.key AS object_key,
         a.nome_original,
         a.content_type
    FROM ordem_item_arquivo a
   WHERE a.ordem_id = $1
     AND a.deleted_at IS NULL
     AND (LOWER(a.nome_original) LIKE '%lista-nomes%' OR a.content_type = 'application/json')
ORDER BY a.item_id, a.id DESC
`, [ordemId]);


  const porItem = new Map(); // item_id -> object_key
  for (const r of rows) {
    if (!porItem.has(r.item_id)) porItem.set(r.item_id, r.object_key);
  }

  const mapas = new Map(); // Map<itemId, Map<tamanho, qtd>>
  for (const [itemId, key] of porItem.entries()) {
    const json = await readR2ObjectAsJson(key);
    const lista = Array.isArray(json?.lista) ? json.lista : [];
    const m = new Map();
    for (const l of lista) {
      const t = String(l?.tamanho || '').trim().toUpperCase();
      if (!t) continue;
      m.set(t, (m.get(t) || 0) + 1);
    }
    mapas.set(itemId, m);
  }
  return mapas;
}

// Valida TODOS os itens da ordem: grade × lista de nomes (só se o item tiver lista)
async function validarItensVsLista(ordemId) {
  const mapaGrade = await carregarMapaGradePorItem(ordemId);
  const mapaLista = await carregarMapaListaPorItem(ordemId);

  const divergencias = [];
  for (const [itemId, mg] of mapaGrade.entries()) {
    const ml = mapaLista.get(itemId);
    if (!ml || ml.size === 0) continue; // item sem lista => não valida

    const tamanhos = new Set([...mg.keys(), ...ml.keys()]);
    for (const t of tamanhos) {
      const qg = mg.get(t) || 0;
      const ql = ml.get(t) || 0;
      if (qg !== ql) divergencias.push({ itemId, tamanho: t, grade: qg, lista: ql });
    }
  }
  if (divergencias.length > 0) {
    const MAX = 10; // mostra no máximo 10 linhas
    const linhas = divergencias.slice(0, MAX)
      .map(d => `Item ${d.itemId} — ${d.tamanho}: grade=${d.grade} vs lista=${d.lista}`);
    const sufixo = divergencias.length > MAX
      ? `\n(+${divergencias.length - MAX} diferenças adicionais)`
      : '';
    const e = new Error(
      `Não foi possível fechar a ordem: as quantidades por tamanho da grade não conferem com a lista de nomes.\n` +
      linhas.join('\n') + sufixo
    );
    e.status = 409;
    throw e;
  }
  
}

/* =========================
   Rotas
========================= */

// Criar nova ordem de produção de uniformes
router.post('/ordens-uniformes', async (req, res) => {
  const {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    usuario_id,
    tipo_ordem // obrigatório
  } = req.body;

  // Validação básica
  if (
    !numero_ordem ||
    !data_entrada ||
    prazo_entrega === undefined ||
    !data_entrega ||
    !cliente ||
    !usuario_id ||
    !tipo_ordem
  ) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  }

  try {
    // Bloqueia duplicidade
    if (await numeroOrdemDuplicado(numero_ordem)) {
      return res.status(409).json({
        erro: 'Já existe uma ordem de produção com esse número. Informe um número diferente para prosseguir.'
      });
    }

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
        numero_ordem, data_entrada, prazo_entrega, data_entrega, cliente, usuario_id, tipo_ordem
      }
    });
  }
});

// POST /ordens-uniformes/:id/enviar
router.post('/ordens-uniformes/:id/enviar', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Atualiza status da ordem
    await client.query(
      `UPDATE ordem_producao_uniformes_dados_ordem
         SET status = 'enviada',
             motivo_devolucao = NULL,
             devolvida_em = NULL
       WHERE id = $1`,
      [id]
    );
    

    // Garante vínculo com setor "configuracao"
    const { rows } = await client.query(
      `SELECT id FROM setores WHERE slug = 'configuracao' LIMIT 1`
    );
    if (rows.length > 0) {
      const setorId = rows[0].id;
      await client.query(
        `INSERT INTO ordem_setores (ordem_id, setor_id, status)
         VALUES ($1, $2, 'aguardando')
         ON CONFLICT (ordem_id, setor_id) DO NOTHING`,
        [id, setorId]
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro ao enviar ordem:', e);
    return res.status(500).json({ erro: 'Falha ao enviar ordem' });
  } finally {
    client.release();
  }
});

// Listar todas as ordens
router.get('/ordens-uniformes', async (req, res) => {
  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem ORDER BY id DESC'
    );
    res.json(resultado.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ordens.' });
  }
});

// Buscar uma ordem por ID
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

// Checagem rápida de duplicidade (usado pelo front antes de fechar)
router.get('/ordens-uniformes/check-duplicado', async (req, res) => {
  const { numero, ignoreId } = req.query;
  if (!numero) return res.json({ duplicado: false });
  const dup = await numeroOrdemDuplicado(numero, ignoreId || null);
  res.json({ duplicado: dup });
});

// Atualizar ordem (auto salvamento / mudar status)
router.put('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  let {
    numero_ordem,
    data_entrada,
    prazo_entrega,
    data_entrega,
    cliente,
    status,
    usuario_id,
    tipo_ordem, // manter se vier do front
  } = req.body;

  // validações mínimas
  const numeroTrim = String(numero_ordem || '').trim();
  if (!numeroTrim) return res.status(400).json({ erro: 'numero_ordem é obrigatório.' });
  if (!data_entrada) return res.status(400).json({ erro: 'data_entrada é obrigatória.' });
  if (prazo_entrega === undefined || prazo_entrega === null)
    return res.status(400).json({ erro: 'prazo_entrega é obrigatório.' });
  if (!data_entrega) return res.status(400).json({ erro: 'data_entrega é obrigatória.' });
  if (!cliente) return res.status(400).json({ erro: 'cliente é obrigatório.' });

  try {
    // 1) Número único
    if (await numeroOrdemDuplicado(numeroTrim, id)) {
      return res.status(409).json({
        erro: 'Já existe uma ordem de produção com esse número. Informe um número diferente para prosseguir.'
      });
      
    }

    // 2) Se for fechar/enviar, validar grade × lista (por item com lista)
    const st = String(status || '').toLowerCase();
    if (st === 'fechada' || st === 'enviada') {
      await validarItensVsLista(id);
    }

    // 3) Atualiza
    const atualizada = await db.query(
      `UPDATE ordem_producao_uniformes_dados_ordem
          SET numero_ordem = $1,
              data_entrada = $2,
              prazo_entrega = $3,
              data_entrega = $4,
              cliente = $5,
              status = $6,
              usuario_id = $7,
              tipo_ordem = COALESCE($8, tipo_ordem)
        WHERE id = $9
      RETURNING *`,
      [
        numeroTrim,
        data_entrada,
        prazo_entrega,
        data_entrega,
        cliente,
        status || 'rascunho',
        usuario_id || null,
        tipo_ordem || null,
        id,
      ]
    );

    res.json(atualizada.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar ordem:', err);
    if (String(err?.code) === '23505') {
      return res.status(409).json({
        erro: 'Já existe uma ordem de produção com esse número. Informe um número diferente para prosseguir.'
      });
    }
    const code = err?.status || 500;
    return res.status(code).json({ erro: err?.message || 'Erro ao atualizar ordem.' });
  }
});

// Excluir ordem (se necessário)
router.delete('/ordens-uniformes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM ordem_producao_uniformes_dados_ordem WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir ordem.' });
  }
});

// Listar todas as ordens de um usuário específico (mantém APENAS esta rota)
router.get('/ordens-uniformes/usuario/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;

  try {
    const resultado = await db.query(
      'SELECT * FROM ordem_producao_uniformes_dados_ordem WHERE usuario_id = $1 ORDER BY id DESC',
      [usuario_id]
    );

    res.json(resultado.rows);
  } catch (err) {
    console.error('Erro ao buscar ordens do usuário:', err);
    res.status(500).json({ erro: 'Erro ao buscar ordens do usuário.' });
  }
});

export default router;
