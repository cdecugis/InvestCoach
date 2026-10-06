FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
