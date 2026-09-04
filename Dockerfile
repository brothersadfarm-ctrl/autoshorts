# AutoShorts 24/7 Production Dockerfile
FROM node:20-bookworm-slim

# Install FFmpeg and required media libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

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
