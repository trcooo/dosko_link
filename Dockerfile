# Railway single-service deploy: builds frontend and serves it from FastAPI
#
# One service, one domain, zero CORS pain:
# - Stage 1 builds the Vite frontend
# - Stage 2 runs FastAPI and serves the built SPA from /static

# Stage 1: build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend

COPY frontend/package*.json ./

# Railway / some builders may force "production" installs.
# We must explicitly include dev deps because Vite is in devDependencies.
ENV NODE_ENV=development
ENV NPM_CONFIG_PRODUCTION=false
RUN npm ci --include=dev --no-audit --no-fund

COPY frontend/ .
RUN npm run build

# Stage 2: backend runtime
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# Copy built frontend into backend/static so FastAPI can serve it
COPY --from=frontend-build /app/frontend/dist ./static

# Railway provides $PORT
CMD ["bash", "-lc", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
