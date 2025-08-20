// routes/visionProvider.js
import client from '../openaiClient.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `
Você recebe listas de nomes com número e tamanho em diversos formatos.
Extraia uma lista JSON no formato:
{ "itens": [ { "nome": "...", "numero": "string|null", "tamanho": "string|null" } ] }

Normalize tamanhos quando possível para:
[2 ANOS, 4 ANOS, 6 ANOS, 8 ANOS, 10 ANOS, 12 ANOS, 14 ANOS, PP, P, M, G, GG, XG, XGG, EXGG]

Ignore ruídos como: conjunto, completo, camisa, calção, short, costas, unidade, cores.
Responda SOMENTE com JSON válido.
`;

async function fromText(text) {
  const resp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text }
    ]
  });
  return JSON.parse(resp.choices[0].message.content);
}

async function fromImage(buffer, mimetype) {
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const resp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extraia a lista de nomes/num/tamanho desta imagem.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  });
  return JSON.parse(resp.choices[0].message.content);
}

export async function extractWithVision({ buffer, mimetype, textFallback }) {
  if (textFallback && textFallback.trim()) {
    return await fromText(textFallback);
  }
  if (buffer && mimetype && mimetype.startsWith('image/')) {
    return await fromImage(buffer, mimetype);
  }
  throw new Error('Por enquanto envie texto ou imagem (jpg/png). PDF/DOCX entram depois.');
}
