FROM node:18-alpine

WORKDIR /app

# Build metadata
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY scripts/check-node.js ./scripts/check-node.js

# Install OS deps for Prisma engines
RUN apk add --no-cache openssl libc6-compat

# Install dependencies
RUN npm ci
RUN npx prisma generate

# Copy source code
COPY src ./src

# Expose port
EXPOSE 3000

# Start the application (allow skipping migrations when needed)
CMD ["sh", "-c", "if [ \"$SKIP_MIGRATIONS\" = \"1\" ]; then npm start; else npx prisma migrate deploy && npm start; fi"]
