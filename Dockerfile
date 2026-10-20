FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY assets ./assets

# config/ is mounted from the host (see docker-compose.yml); the DB is Supabase (DATABASE_URL in .env)
ENV CONFIG_PATH=/app/config/config.yaml

ENTRYPOINT ["node"]
CMD ["src/run.js"]
