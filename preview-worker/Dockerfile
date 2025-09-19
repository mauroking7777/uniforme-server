# Node 22 para casar com "engines": { node: "22.x" }
FROM node:22-bookworm-slim

# Inkscape para conversão
RUN apt-get update \
 && apt-get install -y --no-install-recommends inkscape \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# >>> IMPORTANTE: copie package.json E package-lock.json antes do npm ci
COPY package.json package-lock.json ./

# --omit=dev é o substituto moderno de --only=production
RUN npm ci --omit=dev

# Agora copia o código
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]
