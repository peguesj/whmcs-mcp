# syntax=docker/dockerfile:1.7
#
# @peguesj/whmcs-mcp — multi-stage build to a distroless Node runtime.
#
# Stage 1 (deps):    install full dependency graph (needed for `tsc` devDeps).
# Stage 2 (build):   compile TypeScript -> dist/ with the project's tsconfig.
# Stage 3 (prod-deps): install production-only dependencies into a clean tree,
#                    so the distroless final stage never carries devDependencies
#                    (typescript, eslint, vitest, tsx, etc.) or their transitive
#                    surface.
# Stage 4 (runtime): gcr.io/distroless/nodejs22-debian12, non-root (the
#                    distroless nodejs image ships a built-in `nonroot`
#                    user/group, uid/gid 65532), stdio transport by default
#                    (no ports EXPOSEd or bound unless WHMCS_MCP_HTTP=1, in
#                    which case the operator passes --http and publishes
#                    8080 explicitly at `docker run` time).
#
# Build:   docker build -t whmcs-mcp:local .
# Run:     docker run --rm -i \
#            -e WHMCS_API_URL=https://example.com/includes/api.php \
#            -e WHMCS_API_IDENTIFIER=... \
#            -e WHMCS_API_SECRET=... \
#            whmcs-mcp:local
#
# The image runs `node dist/index.js` (stdio transport) as its entrypoint, so
# an MCP client that spawns this container attaches to stdin/stdout exactly as
# it would a local `whmcs-mcp` binary. No shell, package manager, or writable
# system files exist in the final image.

ARG NODE_VERSION=22

########################################
# Stage 1: deps (full install, cached)
########################################
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Install with dev dependencies so the build stage can run `tsc`.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

########################################
# Stage 2: build (TypeScript -> dist/)
########################################
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src

RUN npm run build \
    && test -f dist/index.js

########################################
# Stage 3: prod-deps (production-only install)
########################################
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

########################################
# Stage 4: runtime (distroless, non-root, stdio default)
########################################
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Default transport is stdio; the server only opens a network listener when
# invoked with --http (see src/index.ts). No PORT is set here on purpose —
# an operator who runs with --http must publish/expose a port explicitly.
ENV WHMCS_MCP_MODE=readonly

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY README.md SECURITY.md LICENSE ./

# gcr.io/distroless/nodejs* images ship a non-root "nonroot" user
# (uid=65532, gid=65532) in addition to root; run as that user rather than
# root so a compromised dependency cannot write into the image or reach
# host-level privileges.
USER nonroot:nonroot

# No EXPOSE: default transport is stdio (no listening socket). If the
# operator runs the image with `["--http"]`, they must also pass
# `-p <hostPort>:8080` (or whatever WHMCS_MCP_HTTP_PORT resolves to) at
# `docker run` time; this Dockerfile intentionally does not assume that mode.

ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
# No CMD args by default => stdio transport. Override at `docker run` with
# `--http` to switch to Streamable HTTP (127.0.0.1-bound per src/index.ts).
