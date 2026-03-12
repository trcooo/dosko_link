FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend

# Force dev dependencies for the frontend build and isolate npm cache.
# Railway was failing on npm ci with an internal npm error, so we use npm install here.
ENV NODE_ENV=development \
    NPM_CONFIG_PRODUCTION=false \
    NPM_CONFIG_CACHE=/tmp/.npm

COPY frontend/package.json frontend/package-lock.json ./
RUN npm install --include=dev --no-fund --no-audit \
 && node -e "require.resolve('vite'); require.resolve('@vitejs/plugin-react'); console.log('frontend deps ok')"

COPY frontend/ ./
RUN node scripts/build.mjs \
 && test -f dist/index.html

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
RUN mkdir -p /app/backend/static
COPY --from=frontend-builder /app/frontend/dist/ /app/backend/static/

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
