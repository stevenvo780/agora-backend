FROM node:22-alpine AS builder
WORKDIR /app
COPY .tarballs ./.tarballs
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY .tarballs ./.tarballs
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Cloud Run injecta PORT; Express lo lee desde process.env.PORT.
EXPOSE 8080
CMD ["node", "dist/index.js"]
