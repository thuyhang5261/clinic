# Phần 1: Multi-stage build for clinic WebRTC Application
FROM node:20-slim AS base

# Install build dependencies for native modules (wrtc package) and FFmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    wget \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodeuser

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code
COPY --chown=nodeuser:nodejs . .

# Remove build dependencies to reduce image size
RUN apt-get remove -y python3 make g++ git && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Switch to non-root user
USER nodeuser

# Expose port
EXPOSE 5000

# Add health check for WebRTC/clinic service
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5000/ || exit 1

# Start application
CMD ["npm", "start"]

# Phần 2: Nginx with RTMP Streaming Support
FROM tiangolo/nginx-rtmp:latest AS nginx-rtmp

# Copy custom nginx configuration for RTMP
COPY nginx.conf /etc/nginx/nginx.conf

# Create directories for streaming
RUN mkdir -p /var/livestream/hls /var/livestream/dash /var/livestream/recordings \
    && chown -R www-data:www-data /var/livestream \
    && chmod -R 755 /var/livestream

# Create log directories
RUN mkdir -p /var/log/nginx \
    && chown -R www-data:www-data /var/log/nginx

# Expose ports for HTTP, HTTPS, and RTMP
EXPOSE 80 443 1935

# Start nginx with RTMP support
CMD ["nginx", "-g", "daemon off;"]

# Phần 3: Nginx Reverse Proxy (Legacy)
FROM nginx:1.25-alpine AS nginx

# Install openssl for SSL certificate handling
RUN apk add --no-cache openssl

# Remove default nginx configuration
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Create SSL certificates directory
RUN mkdir -p /etc/nginx/ssl/phongkhamhongnhan.com

# Copy SSL certificates if available
COPY phongkhamhongnhan.com/ /etc/nginx/ssl/phongkhamhongnhan.com/

# Create nginx user and set permissions (nginx user already exists in nginx:alpine image)
RUN id -u nginx >/dev/null 2>&1 || (groupadd -g 101 nginx && useradd -r -u 101 -g nginx nginx)

# Create required directories for nginx and streaming
RUN mkdir -p /var/cache/nginx /var/log/nginx /var/run /var/livestream/hls /var/livestream/dash /var/livestream/recordings && \
    chown -R www-data:www-data /var/cache/nginx /var/log/nginx /var/run /var/livestream && \
    chmod -R 755 /var/cache/nginx /var/log/nginx /var/livestream

# Don't switch user for nginx-rtmp (needs root for port 1935)

# Expose HTTP, HTTPS and RTMP ports
EXPOSE 80 443 1935

# Health check for nginx
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]