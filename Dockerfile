FROM node:22-bookworm AS build
WORKDIR /app

COPY package*.json ./
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY frontend ./frontend
RUN cd frontend && npm run build

COPY backend ./backend

FROM node:22-bookworm-slim
WORKDIR /app/backend
ENV NODE_ENV=production \
    PORT=3010 \
    HOSTNAME=0.0.0.0 \
    NOVA_TASK_DB=/data/nova-tasks.sqlite \
    NOVA_IMAGE_DIR=/data/nova-images \
    PROMPT_GALLERY_MODE=1
RUN mkdir -p /data
COPY --from=build /app/backend /app/backend
COPY --from=build /app/frontend/out /app/frontend/out
EXPOSE 3010
CMD ["node", "server.js"]
