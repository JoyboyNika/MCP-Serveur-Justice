FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js ./

EXPOSE 3001

USER node

CMD ["node", "server.js"]
