# Usa Node + Debian para conseguir instalar o Inkscape
FROM node:20-bullseye-slim

# Inkscape (renderizador)
RUN apt-get update \
 && apt-get install -y --no-install-recommends inkscape \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Só copia package.json primeiro p/ cache
COPY package.json ./
RUN npm ci --only=production

# Agora o código
COPY index.js ./index.js

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]
