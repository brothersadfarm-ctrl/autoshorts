# AutoShorts 24/7 Production Dockerfile
FROM node:22-bookworm-slim

# Install FFmpeg and build tools for native addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy source code and assets
COPY . .

# Create persistent storage directories
RUN mkdir -p uploads/queue uploads/processed uploads/watermark uploads/test data

# Expose web server port
EXPOSE 5000

# Set environment
ENV NODE_ENV=production
ENV PORT=5000

# Start server and scheduler daemon
CMD ["node", "server/index.js"]
