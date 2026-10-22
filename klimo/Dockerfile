# ---- Frontend build ----
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
# sources only: a node_modules or dist left in a local checkout must not replace what was installed here
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/scripts ./scripts
COPY frontend/src ./src
RUN npm run build

# ---- Backend build ----
FROM node:22-alpine AS backend
# toolchain for native modules (better-sqlite3 compiles from source on musl)
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime ----
# Same image as the build stages: native modules (better-sqlite3) are ABI-compatible by construction.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    KLIMO_DATA_DIR=/data \
    KLIMO_PUBLIC_DIR=/app/public \
    KLIMO_CARD_DIR=/app/card \
    KLIMO_PORT=8099
COPY --from=backend /build/dist ./dist
COPY --from=backend /build/node_modules ./node_modules
COPY --from=backend /build/package.json ./package.json
COPY backend/assets ./assets
COPY --from=frontend /build/dist ./public
# the Lovelace bundle only (card/dev is the development harness)
COPY card/klimo-cards.js ./card/klimo-cards.js
# backup_pre / backup_post hooks: flush and pause writes, checkpoint the SQLite WAL
COPY backup-hook.sh /app/backup-hook.sh
RUN chmod +x /app/backup-hook.sh
EXPOSE 8099
CMD [ "node", "dist/main.js" ]
