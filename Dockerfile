# Use Debian-based Node image (Sharp compatible)
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install only production dependencies
COPY package.json ./
RUN npm install --production

# Copy application source
COPY . .

# Cloud Run listens on 8080
EXPOSE 8080

# Start server
CMD ["node", "server.js"]
