# crosspoint-sync — no native deps (uses Node's built-in node:sqlite)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The CrossPoint Sync app's web build (the same React app the phone/desktop app
# ships), served at /app/. Only the web half: no Rust/Tauri build needed.
FROM node:24-alpine AS web
WORKDIR /web
COPY app/package.json app/package-lock.json ./
RUN npm ci --ignore-scripts
COPY app/index.html app/vite.config.js ./
COPY app/public ./public
COPY app/src ./src
RUN npx vite build

FROM node:24-alpine
ENV NODE_ENV=production \
    DATABASE_PATH=/data/crosspoint.db \
    PORT=8080 \
    WEB_APP_DIR=/app/web
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
COPY migrations ./migrations
COPY assets ./assets
COPY extension ./extension
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "dist/index.js"]
