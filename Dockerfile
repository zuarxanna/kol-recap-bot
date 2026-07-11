# --- build stage: compile TypeScript -> dist/ (needs devDeps: typescript) ---
# Node 22 LTS alpine — deps are pure JS (apify-client/dotenv/telegraf), global fetch (>=18) for YouTube.
FROM node:22-alpine AS build
WORKDIR /app

# Deps layer first (cache-friendly): only reinstalls when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

# Source + config, then compile.
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build

# --- runtime stage: prod deps + compiled JS only (no TypeScript, no devDeps) ---
FROM node:22-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled output + db JSON as an initial fallback (the ./db volume overlays it at runtime).
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db

# Run as non-root (the node image has a 'node' user). db/ & out/ are written via bind
# volumes (host perms apply; transparent on Docker Desktop/Mac). Data paths resolve from
# the working directory (/app), so they land on the mounted volumes.
USER node

# Long-polling: NO port/EXPOSE. Entry = the compiled bot (always-on).
CMD ["node", "dist/src/index.js"]
