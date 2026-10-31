# Build context: the project root. Serves the Expo web export for previews; store builds use your own pipeline.
FROM node:22.11-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build -w mobile

FROM caddy:2.8-alpine
COPY --from=build /app/mobile/dist /srv
USER 1000
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8081/ || exit 1
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":8081"]
