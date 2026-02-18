FROM node:20-bullseye

# Install Chrome dependencies for Puppeteer
RUN apt-get update \
  && apt-get install -y wget gnupg \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Environment Variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
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
