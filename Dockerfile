# Railway single-service deploy: builds frontend and serves it from FastAPI
# Stage 1: build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
ENV NPM_CONFIG_PRODUCTION=false
ENV NODE_ENV=development
RUN npm ci
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
