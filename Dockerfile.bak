FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend
ENV NODE_ENV=development \
    NPM_CONFIG_PRODUCTION=false
COPY frontend/package.json frontend/package-lock.json ./
RUN npm cache clean --force \
 && npm install --include=dev --no-fund --no-audit \
 && npm install --no-save vite@5.4.2 @vitejs/plugin-react@4.3.1 --no-fund --no-audit \
 && node -e "require.resolve('vite'); require.resolve('@vitejs/plugin-react'); console.log('frontend deps ok')"
COPY frontend/ ./
RUN rm -f .npmrc \
 && node -e "require.resolve('vite'); console.log('vite ok')" \
 && npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
RUN mkdir -p /app/backend/static
COPY --from=frontend-builder /app/frontend/dist/ /app/backend/static/
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
