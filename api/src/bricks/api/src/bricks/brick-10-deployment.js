// brick-10-deployment.js
// PCAux Diamond Platform - Brick #10: Deployment Config
// Docker, SSL, domain, CI/CD, production hardening

// ==================== DOCKER COMPOSE ====================

// docker-compose.yml
const dockerCompose = `
version: '3.8'

services:
  # API Layer
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.prod
    container_name: pcaux-api
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://\${DB_USER}:\${DB_PASSWORD}@db:5432/pcaux
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=\${JWT_SECRET}
      - AWS_REGION=\${AWS_REGION}
      - AWS_ACCESS_KEY_ID=\${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=\${AWS_SECRET_ACCESS_KEY}
      - S3_BUCKET=\${S3_BUCKET}
      - CGL_API_KEY=\${CGL_API_KEY}
      - GIA_API_KEY=\${GIA_API_KEY}
      - STRIPE_SECRET_KEY=\${STRIPE_SECRET_KEY}
      - WEBHOOK_SECRET=\${WEBHOOK_SECRET}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
      migrate:
        condition: service_completed_successfully
    volumes:
      - api-logs:/app/logs
      - api-uploads:/app/uploads
    networks:
      - pcaux-network
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
        reservations:
          cpus: '1.0'
          memory: 1G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  # Frontend (Served via Nginx)
  web:
    build:
      context: ./frontend
      dockerfile: Dockerfile.prod
    container_name: pcaux-web
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - API_URL=http://api:3000
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
      - web-cache:/var/cache/nginx
    depends_on:
      - api
    networks:
      - pcaux-network
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M

  # Database
  db:
    image: postgres:15-alpine
    container_name: pcaux-db
    restart: unless-stopped
    environment:
      - POSTGRES_USER=\${DB_USER}
      - POSTGRES_PASSWORD=\${DB_PASSWORD}
      - POSTGRES_DB=pcaux
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d
    networks:
      - pcaux-network
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER} -d pcaux"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis (Caching, Sessions, Rate Limiting)
  redis:
    image: redis:7-alpine
    container_name: pcaux-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    networks:
      - pcaux-network
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M

  # Database Migrations
  migrate:
    build:
      context: ./api
      dockerfile: Dockerfile.prod
    command: ["npm", "run", "migrate"]
    environment:
      - DATABASE_URL=postgres://\${DB_USER}:\${DB_PASSWORD}@db:5432/pcaux
    depends_on:
      db:
        condition: service_healthy
    networks:
      - pcaux-network
    restart: "no"

  # Background Job Processor
  worker:
    build:
      context: ./api
      dockerfile: Dockerfile.prod
    command: ["npm", "run", "worker"]
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://\${DB_USER}:\${DB_PASSWORD}@db:5432/pcaux
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    networks:
      - pcaux-network
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '1.0'
          memory: 1G

  # Scheduled Tasks (Cron)
  scheduler:
    build:
      context: ./api
      dockerfile: Dockerfile.prod
    command: ["npm", "run", "scheduler"]
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://\${DB_USER}:\${DB_PASSWORD}@db:5432/pcaux
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    networks:
      - pcaux-network

volumes:
  postgres-data:
    driver: local
  redis-data:
    driver: local
  api-logs:
    driver: local
  api-uploads:
    driver: local
  web-cache:
    driver: local

networks:
  pcaux-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
`;

// ==================== API DOCKERFILE ====================

// api/Dockerfile.prod
const apiDockerfile = `
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source
COPY . .

# Production stage
FROM node:20-alpine

# Install security updates
RUN apk update && apk upgrade && apk add --no-cache curl ca-certificates

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown nodejs:nodejs logs

# Switch to non-root
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \\
  CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["node", "server.js"]
`;

// ==================== FRONTEND DOCKERFILE ====================

// frontend/Dockerfile.prod
const frontendDockerfile = `
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY . .
RUN npm run build

# Production stage (Nginx)
FROM nginx:1.25-alpine

# Security headers and config
RUN apk add --no-cache curl

# Copy custom nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Create cache directory
RUN mkdir -p /var/cache/nginx && chown nginx:nginx /var/cache/nginx

# Non-root user
USER nginx

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
`;

// ==================== NGINX CONFIG ====================

// nginx/nginx.conf
const nginxConf = `
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging format
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for" '
                    'rt=$request_time uct="$upstream_connect_time" '
                    'uht="$upstream_header_time" urt="$upstream_response_time"';

    access_log /var/log/nginx/access.log main;

    # Performance
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    # Rate limiting zones
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
    limit_conn_zone $binary_remote_addr zone=addr:10m;

    # Upstream API
    upstream api {
        least_conn;
        server api:3000 max_fails=3 fail_timeout=30s;
        keepalive 32;
    }

    # HTTP to HTTPS redirect
    server {
        listen 80;
        server_name pcaux.io www.pcaux.io;
        
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }
        
        location /health {
            access_log off;
            return 200 "healthy\\n";
            add_header Content-Type text/plain;
        }
        
        location / {
            return 301 https://$server_name$request_uri;
        }
    }

    # HTTPS Server
    server {
        listen 443 ssl http2;
        server_name pcaux.io www.pcaux.io;

        # SSL certificates (mounted from host)
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        
        # Modern SSL configuration
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
        ssl_prefer_server_ciphers off;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 1d;
        ssl_session_tickets off;
        
        # OCSP Stapling
        ssl_stapling on;
        ssl_stapling_verify on;
        ssl_trusted_certificate /etc/nginx/ssl/chain.pem;
        
        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://api.pcaux.io wss://ws.pcaux.io;" always;
        add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

        # HSTS (uncomment after SSL confirmed working)
        # add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

        # API proxy
        location /api {
            limit_req zone=api burst=20 nodelay;
            
            proxy_pass http://api;
            proxy_http_version 1.1;
            
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Host $host;
            proxy_set_header X-Forwarded-Port $server_port;
            
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
            
            proxy_buffering on;
            proxy_buffer_size 4k;
            proxy_buffers 8 4k;
            
            # WebSocket upgrade
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        # WebSocket endpoint
        location /ws {
            proxy_pass http://api;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 86400;
        }

        # Static assets (React app)
        location / {
            root /usr/share/nginx/html;
            index index.html;
            try_files $uri $uri/ /index.html;
            
            # Cache static assets
            location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
                expires 1y;
                add_header Cache-Control "public, immutable";
                access_log off;
            }
            
            # Never cache HTML
            location ~* \\.html$ {
                expires -1;
                add_header Cache-Control "no-store, no-cache, must-revalidate";
            }
        }

        # Health check
        location /health {
            access_log off;
            return 200 "healthy\\n";
            add_header Content-Type text/plain;
        }

        # Block hidden files
        location ~ /\\. {
            deny all;
            return 404;
        }
    }
}
`;

// ==================== GITHUB ACTIONS CI/CD ====================

// .github/workflows/deploy.yml
const githubActions = `
name: Deploy PCAux

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: pcaux_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: api/package-lock.json
      
      - name: Install API dependencies
        working-directory: ./api
        run: npm ci
      
      - name: Run API tests
        working-directory: ./api
        env:
          DATABASE_URL: postgres://postgres:test@localhost:5432/pcaux_test
          JWT_SECRET: test-secret
        run: |
          npm run migrate
          npm test
      
      - name: Install Frontend dependencies
        working-directory: ./frontend
        run: npm ci
      
      - name: Build Frontend
        working-directory: ./frontend
        run: npm run build
      
      - name: Lint Frontend
        working-directory: ./frontend
        run: npm run lint

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Configure SSH
        uses: webfactory/ssh-agent@v0.8.0
        with:
          ssh-private-key: \${{ secrets.SSH_PRIVATE_KEY }}
      
      - name: Deploy to Production
        env:
          HOST: \${{ secrets.PROD_HOST }}
          USER: \${{ secrets.PROD_USER }}
        run: |
          ssh -o StrictHostKeyChecking=no $USER@$HOST << 'EOF'
            cd /opt/pcaux
            git pull origin main
            docker-compose -f docker-compose.yml pull
            docker-compose -f docker-compose.yml up -d --build
            docker system prune -f
          EOF
      
      - name: Notify Slack
        if: always()
        uses: 8398a7/action-slack@v3
        with:
          status: \${{ job.status }}
          channel: '#deployments'
          webhook_url: \${{ secrets.SLACK_WEBHOOK }}
`;

// ==================== ENVIRONMENT TEMPLATE ====================

// .env.example
const envExample = `
# Database
DB_USER=pcaux
DB_PASSWORD=change_this_to_32_char_random
DB_NAME=pcaux

# Redis
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=change_this_to_64_char_random_string_min
ENCRYPTION_KEY=change_this_for_database_encryption

# AWS / S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=pcaux-production-images
S3_CDN_URL=https://images.pcaux.io

# Grader APIs
CGL_API_KEY=cgl_live_...
CGL_API_URL=https://api.cgl.org/v1
GIA_API_KEY=gia_live_...
GIA_API_URL=https://api.gia.edu/v1

# Payments
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

# Frontend
VITE_API_URL=https://api.pcaux.io
VITE_WS_URL=wss://ws.pcaux.io
VITE_S3_URL=https://images.pcaux.io

# Monitoring
SENTRY_DSN=https://...@sentry.io/...
DATADOG_API_KEY=...

# Email
SENDGRID_API_KEY=SG...
EMAIL_FROM=noreply@pcaux.io

# Feature Flags
ENABLE_RUSH_GRADING=true
ENABLE_LIQUIDATION=true
MAX_IPO_DURATION_DAYS=90
`;

// ==================== DEPLOYMENT SCRIPTS ====================

// scripts/deploy.sh
const deployScript = `
#!/bin/bash
set -e

echo "🚀 PCAux Deployment Starting..."

# Configuration
COMPOSE_FILE="docker-compose.yml"
BACKUP_DIR="/backups/pcaux/$(date +%Y%m%d_%H%M%S)"

# Create backup directory
mkdir -p $BACKUP_DIR

echo "📦 Backing up database..."
docker exec pcaux-db pg_dump -U pcaux pcaux > $BACKUP_DIR/db_backup.sql

echo "🔄 Pulling latest code..."
git pull origin main

echo "🔧 Building and starting services..."
docker-compose -f $COMPOSE_FILE pull
docker-compose -f $COMPOSE_FILE up -d --build

echo "⏳ Waiting for health checks..."
sleep 10

# Verify health
if ! curl -f http://localhost:3000/health; then
    echo "❌ API health check failed! Rolling back..."
    docker-compose -f $COMPOSE_FILE down
    # Restore from backup logic here
    exit 1
fi

echo "🧹 Cleaning up..."
docker system prune -f
docker volume prune -f

echo "✅ Deployment complete!"
echo "📊 Current status:"
docker-compose -f $COMPOSE_FILE ps
`;

// ==================== MONITORING SETUP ====================

// monitoring/docker-compose.monitoring.yml
const monitoringCompose = `
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=\${GRAFANA_PASSWORD}
    ports:
      - "3001:3000"

  loki:
    image: grafana/loki:latest
    volumes:
      - ./loki-config.yml:/etc/loki/local-config.yaml
      - loki-data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "3100:3100"

volumes:
  prometheus-data:
  grafana-data:
  loki-data:
`;

// Export all configurations
module.exports = {
  dockerCompose,
  apiDockerfile,
  frontendDockerfile,
  nginxConf,
  githubActions,
  envExample,
  deployScript,
  monitoringCompose
};
