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
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy dependency files first (caching)
COPY package*.json ./
COPY client/package*.json ./client/

# Install dependencies
# We install devDependencies too because we need them to build the client
RUN npm ci
RUN cd client && npm ci

# Copy source code
COPY . .

# Build Client
RUN cd client && npm run build

# Prune dev dependencies to save space (optional, but good practice)
# RUN npm prune --production
# Note: kept commented out in case some devDeps are needed at runtime by mistake (e.g. nodemon in start script?) 
# Ideally we should use 'npm ci --omit=dev' after building, but let's be safe for now.

# Expose Port
EXPOSE 3000

# Start Command
CMD ["npm", "start"]
