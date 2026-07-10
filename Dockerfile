# Ikvizz — container image for free cloud hosting (Render / Railway / Fly / any Docker host).
# Node 24 ships the built-in SQLite driver (node:sqlite) the app relies on.
FROM node:24-slim

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# The data dir holds the local SQLite DB + JWT secret. On free tiers this is
# ephemeral (resets on redeploy) unless a persistent volume is attached.
RUN mkdir -p data
ENV NODE_ENV=production

# Cloud hosts inject $PORT; the server already reads process.env.PORT.
EXPOSE 4321
CMD ["node", "server/index.js"]
