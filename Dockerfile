FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend
ENV NODE_ENV=development
COPY frontend/package*.json ./
RUN npm ci --include=dev && npm install -g vite@5.4.2
COPY frontend/ ./
RUN rm -f .npmrc && npm run build

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
