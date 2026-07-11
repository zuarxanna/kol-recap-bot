# Node 22 LTS alpine — deps are pure JS (apify-client/dotenv/telegraf), global fetch (>=18) for YouTube.
FROM node:22-alpine

WORKDIR /app

# Deps layer first (cache-friendly): only reinstalls when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The rest of the source. db/ is copied as an initial fallback but is overlaid by a volume at runtime.
COPY . .

# Run as non-root (the node image has a 'node' user). db/ & out/ are written via bind
# volumes (host perms apply; transparent on Docker Desktop/Mac).
USER node

# Long-polling: NO port/EXPOSE. Entry = the bot (always-on).
CMD ["node", "src/bot.js"]
