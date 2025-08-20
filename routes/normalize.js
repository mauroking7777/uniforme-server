// services/normalize.js

const SIZE_ORDER = [
  '2 ANOS','4 ANOS','6 ANOS','8 ANOS','10 ANOS','12 ANOS','14 ANOS',
  'PP','P','M','G','GG','XG','XGG','EXGG'
];

const SIZE_ALIASES = {
  PP:'PP', P:'P', M:'M', G:'G', GG:'GG', XG:'XG', XGG:'XGG', EXGG:'EXGG',
  'X-G':'XG', 'X.G':'XG', 'EX GG':'EXGG', 'EX-GG':'EXGG', 'EX.GG':'EXGG',
  'G G':'GG', 'G-G':'GG', 'G.G':'GG'
};

const NOISE_WORDS = [
  'CONJUNTO','COMPLETO','SÓ','CAMISA','CAMISETA','CALÇÃO','CALCAO','SHORT',
  'COSTA','COSTAS','UNIDADE','UNIDADES','GOLEIRO','GOLEIROS',
  'ALPHAVILLE','VILLE','BAIRRO','PRETO','BRANCO','VERMELHO','AZUL','VERDE',
  'PRETA','LARANJA','TURQUEZA','MASCULINO','FEMININO','ADULTO','INFANTIL',
  'TOTAL'
];
const NOISE_RE = new RegExp(`\\b(?:${NOISE_WORDS.join('|')})\\b`, 'i');

function normalizeSize(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase().trim();

  let m = s.match(/^(\d{1,2})\s*(ANOS?|A)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const kids = new Set([2,4,6,8,10,12,14]);
    if (kids.has(n)) return `${n} ANOS`;
  }
  m = s.match(/^(\d{1,2})\s*ANOS?$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const kids = new Set([2,4,6,8,10,12,14]);
    if (kids.has(n)) return `${n} ANOS`;
  }

  if (SIZE_ALIASES[s]) return SIZE_ALIASES[s];
  const compact = s.replace(/[^A-Z]/g, '');
  if (SIZE_ALIASES[compact]) return SIZE_ALIASES[compact];
  if (SIZE_ORDER.includes(compact)) return compact;

  return null;
}

function cleanupName(raw, numero, tamanho) {
  if (!raw) return null;
  let s = String(raw);

  s = s.replace(/\bNOME\b\s*[:=]/ig, ' ');
  s = s.replace(/\bN[º°O]|\bNÚM(?:ERO)?|\bNUM(?:ERO)?|#\b/ig, ' ');
  s = s.replace(/\bTAM(?:ANHO)?\b\s*[:=]/ig, ' ');

  if (tamanho) {
    const esc = tamanho.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'ig'), ' ');
  }
  if (numero) {
    s = s.replace(new RegExp(`\\b${numero}\\b`, 'g'), ' ');
  }

  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(NOISE_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  return s || null;
}

module.exports = { normalizeSize, cleanupName, SIZE_ORDER };
