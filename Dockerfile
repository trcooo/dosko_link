# Railway single-service deploy: builds frontend and serves it from FastAPI
#
# One service, one domain:
# - Stage 1 builds the Vite frontend
# - Stage 2 runs FastAPI and serves the built SPA from /static
#
# This Dockerfile is hardened for Railway builds where npm may default to
# production installs (omitting devDependencies). Vite is required at build time.

# Stage 1: build frontend
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend

# Use a stable npm version and force devDependencies to be installed
RUN npm i -g npm@10.9.2
ENV NODE_ENV=development \
    NPM_CONFIG_PRODUCTION=false \
    NPM_CONFIG_OMIT=

# Copy lockfile explicitly (npm ci requires it)
COPY frontend/package.json frontend/package-lock.json ./

# Install deps (dev deps included) and avoid optional deps to reduce flakiness
RUN npm ci --no-audit --no-fund --omit=optional

# Build
COPY frontend/ ./
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
