FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY data ./data
COPY public ./public

# 云托管会注入 PORT 环境变量，server.js 已支持
EXPOSE 3000
CMD ["node", "server.js"]
