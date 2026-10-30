FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/model.ts src/map-model.ts src/canvas.ts src/icons.ts src/types.ts ./src/
COPY server ./server
COPY examples/metamodel.json ./examples/metamodel.json
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WARDLEY_WORKSPACE=/data
EXPOSE 8080
ENTRYPOINT ["/app/server/entrypoint.sh"]
CMD ["node", "server/main.ts"]
