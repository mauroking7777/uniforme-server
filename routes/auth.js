import jwt from 'jsonwebtoken';

export function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ erro: 'Sem token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // opcional: id, nome, etc
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido/expirado' });
  }
}
