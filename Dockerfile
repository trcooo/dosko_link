FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend

# Force a clean, reproducible install of frontend deps from lockfile.
# Railway/CI environments may have npm production flags set globally,
# so we explicitly include devDependencies (Vite and the React plugin).
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev --no-fund --no-audit \
 && node -e "require.resolve('vite'); require.resolve('@vitejs/plugin-react'); console.log('frontend deps ok')"

COPY frontend/ ./
RUN rm -f .npmrc \
 && node -e "require.resolve('vite'); console.log('vite module ok')" \
 && node --input-type=module -e "const vite = await import('vite'); await vite.build(); console.log('vite build ok')" \
 && test -f dist/index.html

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
RUN mkdir -p /app/backend/static
COPY --from=frontend-builder /app/frontend/dist/ /app/backend/static/

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
