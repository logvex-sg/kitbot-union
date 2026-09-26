# syntax=docker/dockerfile:1.7
# UnionKitBot monorepo image. Build context is the repository root.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# ------------------------------------------------------------------ deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/agent/package.json apps/agent/
COPY apps/discord/package.json apps/discord/
COPY apps/ui/package.json apps/ui/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/schemas/package.json packages/schemas/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ----------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN pnpm build

# --------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
RUN useradd --create-home --uid 10001 botuser && chown -R botuser:botuser /app
USER botuser
CMD ["node", "apps/api/dist/index.js"]
