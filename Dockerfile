FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Install tini for proper PID 1 signal handling with multiple processes
RUN apk add --no-cache tini git
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules
# Copy source files needed by the worker (tsx runs them directly)
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# Startup script that runs both processes under tini
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-start.sh ./docker-start.sh
RUN chmod +x ./docker-start.sh
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Use tini as init to properly reap zombie processes and forward signals
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./docker-start.sh"]
