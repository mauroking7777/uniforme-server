FROM node:18-slim

# Inkscape (usa libcdr para importar .cdr)
RUN apt-get update \
 && apt-get install -y --no-install-recommends inkscape ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY index.js ./

EXPOSE 4001
CMD ["node", "index.js"]
