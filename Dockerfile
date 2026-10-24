# Self-hosting image: backend + dashboard in one container (used by docker-compose.yml).
FROM node:22-bookworm-slim AS dashboard
WORKDIR /src/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/test ./test
COPY backend/migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=backend /src/backend/node_modules ./node_modules
COPY --from=backend /src/backend/dist ./dist
COPY --from=backend /src/backend/package.json ./
COPY backend/migrations ./migrations
COPY --from=dashboard /src/dashboard/dist /app/dashboard/dist
USER node
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=process.env.TLS_CERT_PATH?require('https'):require('http');s.get({host:'127.0.0.1',port:process.env.PORT||8443,path:'/healthz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
