FROM node:20-alpine

WORKDIR /app

# Install backend deps
COPY backend/package.json /app/backend/
RUN cd /app/backend && npm install

# Copy app source
COPY backend /app/backend
COPY frontend /app/frontend

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "backend/index.js"]

