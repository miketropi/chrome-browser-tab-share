FROM node:24.7.0-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build -w @tab-share/protocol && npm run build -w @tab-share/server && npm run build -w @tab-share/web
RUN npm prune --omit=dev
FROM node:24.7.0-alpine3.22
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/protocol/package.json ./packages/protocol/package.json
EXPOSE 3000
CMD ["node","apps/server/dist/server.js"]
