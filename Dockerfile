FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma

# Install OS deps for Prisma engines
RUN apk add --no-cache openssl openssl1.1-compat libc6-compat

# Install dependencies
RUN npm ci
RUN npx prisma generate

# Copy source code
COPY src ./src

# Expose port
EXPOSE 3000

# Start the application
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
