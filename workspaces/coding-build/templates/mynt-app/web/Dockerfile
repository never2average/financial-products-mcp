# Build context: the project root. Serves the built app and proxies /api to the api service.
FROM node:22.11-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build -w mynt-sdk && npm run build -w web

FROM caddy:2.8-alpine
COPY --from=build /app/web/dist /srv
COPY web/Caddyfile /etc/caddy/Caddyfile
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ || exit 1
