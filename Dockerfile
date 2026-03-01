# Railway single-service deploy: builds frontend and serves it from FastAPI
#
# One service, one domain:
# - Stage 1 builds the Vite frontend (uses Yarn via Corepack to avoid npm flakiness on some builders)
# - Stage 2 runs FastAPI and serves the built SPA from /static

# Stage 1: build frontend
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend

# Ensure devDependencies are installed (Vite is in devDependencies)
ENV NODE_ENV=development

# Use Corepack-managed Yarn (no npm install -g yarn)
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# Copy manifest/lock first for better layer caching
COPY frontend/package*.json ./

# Install deps (includes dev deps by default)
RUN yarn install --non-interactive --network-timeout 600000

# Copy the rest and build
COPY frontend/ ./
RUN yarn build


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
