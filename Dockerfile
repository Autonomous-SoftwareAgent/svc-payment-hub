# syntax=docker/dockerfile:1
# Payment Hub: image tối thiểu, chạy non-root, không bí mật, không test/docs (xem .dockerignore).
# Build:  docker build --target hub -t bsn-payment-hub .
# Mục tiêu `sim` chỉ dùng chạy thử local (cổng giả), KHÔNG đẩy lên registry.
# Cơ sở dữ liệu là PostgreSQL bên ngoài (HUB_DATABASE_URL), image không chứa dữ liệu.

FROM node:24-alpine AS base
WORKDIR /app

# Cài thư viện chạy (pg, kafkajs) theo đúng bản đã khóa trong package-lock.json; tầng này không vào image cuối ngoài node_modules.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM base AS sim
COPY tools/sim ./tools/sim
USER node
CMD ["node", "tools/sim/momo/server.js"]

FROM base AS hub
ENV NODE_ENV=production
# kafkajs 2.2.4 gọi setTimeout với số âm trên Node >= 22 (lỗi đã biết, vô hại, chỉ in một cảnh báo); tắt đúng cảnh báo đó, không tắt cảnh báo khác.
ENV NODE_OPTIONS=--disable-warning=TimeoutNegativeWarning
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
