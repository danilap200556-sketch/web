FROM node:22-alpine
ENV NODE_ENV=production
# Обработка фото (sharp), хеширование паролей и DNS идут через общий пул потоков Node: по умолчанию в нём 4 потока, и пачка фото
# задерживала бы вход покупателей и обращения к базе. Побольше потоков - без очередей.
ENV UV_THREADPOOL_SIZE=8
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY src ./src
# Только создание/сброс пароля сотрудников админки: docker compose exec shop node scripts/create-admin.js <логин>
COPY scripts/create-admin.js ./scripts/create-admin.js
COPY public ./public
# Папка кэша готовых фото: в docker-compose сюда подключается том, который переживает обновление сайта
RUN mkdir -p /cache/media && chown -R node:node /cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
