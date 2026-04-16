FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p /data/whatsapp-auth
ENV WA_AUTH_DIR=/data/whatsapp-auth

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
