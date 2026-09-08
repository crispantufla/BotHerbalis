# Debian 12 (bookworm), con soporte hasta 2028. Bullseye salió de LTS el
# 2026-08-31 y su repo de seguridad quedó muerto (deploys caídos el 2026-09-08).
FROM node:20-bookworm

# Install Chrome dependencies for Puppeteer.
# En bookworm `apt-key` está deprecado: la clave de Google va a un keyring propio
# y el repo la referencia con signed-by.
RUN apt-get update \
  && apt-get install -y wget gnupg ca-certificates \
  && install -d -m 0755 /etc/apt/keyrings \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Environment Variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
  DATA_DIR=/app/data \
  PORT=3000

WORKDIR /app

# Copy dependency files first (caching)
COPY package*.json ./
COPY client/package*.json ./client/

# Install dependencies
# Force installation of devDependencies (needed for Vite build) regardless of NODE_ENV
RUN npm ci --production=false
RUN cd client && npm ci --production=false

# Copy source code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Copy prices.json to /app/config/ so it survives Railway volume mount at /app/data/
RUN mkdir -p /app/config && cp /app/data/prices.json /app/config/prices.json 2>/dev/null || true

# Build Client
ARG VITE_API_KEY
ENV VITE_API_KEY=$VITE_API_KEY
RUN cd client && npm run build

# Set production environment for runtime
ENV NODE_ENV=production

# Prune dev dependencies to save space (Optional but recommended)
RUN npm prune --production && cd client && npm prune --production

# Expose Port
EXPOSE 3000

# Start Command
CMD ["npm", "start"]
