FROM node:22-bookworm-slim

# Ferramentas de conversão
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      inkscape \
      libreoffice \
      poppler-utils \
      fonts-dejavu \
      fonts-liberation \
      fonts-noto \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests primeiro (aproveitar cache) — usa seu package-lock.json
COPY package.json package-lock.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

# Código
COPY . .

ENV PORT=10000 \
    CONVERT_TIMEOUT_SEC=90 \
    TMP_DIR=/tmp
EXPOSE 10000

CMD ["node", "index.js"]
