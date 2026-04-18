FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p /data/telegram
ENV TELEGRAM_DATA_DIR=/data/telegram

CMD ["npx", "tsx", "src/index.ts"]
