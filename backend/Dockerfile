# Stage 1: Dependencies (all deps for tsx runtime)
FROM node:20-slim AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL dependencies (tsx needs dev dependencies)
RUN npm ci && \
    npm cache clean --force

# Generate Prisma Client
RUN npx prisma generate

# Stage 2: Production runtime (Hardened)
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies first
# ffmpeg is required for audio transcoding
# openssl is required for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tini \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy all node_modules (including tsx)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY --from=deps /app/prisma ./prisma

# Copy source code (will run with tsx, not compiled)
COPY src ./src

# Copy healthcheck script and shell entrypoint
COPY healthcheck.js ./
COPY docker-entrypoint.sh /usr/local/bin/

# Create directories, fix line endings, set permissions, then remove dangerous tools
# NOTE: We keep /bin/sh because npm/npx require it to spawn processes
RUN mkdir -p /app/cache/covers /app/cache/transcodes /app/logs && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    # Remove download/network utilities (prevents downloading malware)
    rm -f /usr/bin/wget /usr/bin/curl /bin/wget /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true && \
    chmod -R a+rw /app

EXPOSE 3006

# Health check using Node.js (no wget needed)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
