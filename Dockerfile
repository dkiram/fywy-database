# syntax=docker/dockerfile:1
#
# Builds one image containing the compiled Express API and the built React
# frontend. The API serves both, so staff computers only ever talk to a single
# origin and no CORS or second web container is involved.
#
# The NAS is x86_64. If this image is built on an Apple Silicon Mac rather than
# on the NAS itself, build it with:  docker buildx build --platform linux/amd64


# ---------------------------------------------------------------------------
# Stage 1 - build the React frontend
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS client-build

WORKDIR /build/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2 - compile the TypeScript API
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS server-build

WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 3 - production dependencies only
#
# bcrypt is a native module. This stage keeps the toolchain it may need to
# compile; the final image never carries compilers.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev


# ---------------------------------------------------------------------------
# Stage 4 - runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV TZ=America/Jamaica

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps         /deps/node_modules      ./node_modules
COPY --from=server-build /build/server/dist      ./dist
COPY --from=client-build /build/client/dist      ./client-dist
COPY server/package.json ./package.json

USER node

EXPOSE 3000

# The API reports unhealthy if it cannot reach PostgreSQL, so Docker restarts
# it rather than leaving a process up that cannot serve anybody.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
