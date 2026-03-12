FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend
ENV NODE_ENV=development \
    NPM_CONFIG_PRODUCTION=false \
    NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    npm_config_registry=https://registry.npmjs.org/ \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY frontend/package.json frontend/package-lock.json ./
RUN node -e "const fs=require('fs');const p='package-lock.json';let s=fs.readFileSync(p,'utf8');s=s.replace(/https:\/\/packages\.[^\"']+\/artifactory\/api\/npm\/npm-public/g,'https://registry.npmjs.org');fs.writeFileSync(p,s);console.log('lockfile sanitized')" \
 && npm install -g npm@10.9.2 --no-fund --no-audit \
 && npm --version \
 && npm ci --include=dev
COPY frontend/ ./
RUN node -e "require.resolve('vite'); require.resolve('@vitejs/plugin-react'); console.log('frontend deps ok')" \
 && npm run build \
 && test -f dist/index.html

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
RUN mkdir -p /app/backend/static
COPY --from=frontend-builder /app/frontend/dist/ /app/backend/static/
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
