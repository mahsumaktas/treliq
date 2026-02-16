# Treliq - AI-Powered PR Triage
# Multi-stage build for minimal image size

FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production && npm cache clean --force
COPY --from=builder /app/dist/ ./dist/
COPY dashboard/ ./dashboard/
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4747/health || exit 1
CMD ["node", "dist/cli.js", "server", "--port", "4747", "--host", "0.0.0.0", "--db-path", "/data/treliq.db"]
