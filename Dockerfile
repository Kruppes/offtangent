FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22

# Install system packages
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    curl \
    wget \
    build-essential \
    jq \
    ca-certificates \
    gnupg \
    sudo \
    gosu \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN node --version && npm --version && git --version && python3 --version && jq --version

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/telegram/package.json packages/telegram/
COPY packages/web-backend/package.json packages/web-backend/
COPY packages/web-frontend/package.json packages/web-frontend/

# Install dependencies (include devDependencies for TypeScript type declarations)
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build all packages
RUN npm run build

# Test gate: the image build is the only environment where the native
# modules (better-sqlite3, oxc-parser) exist, so the full vitest suite runs
# HERE — a red suite fails the build and therefore blocks the deploy.
# Escape hatch for emergency deploys: --build-arg RUN_TESTS=0
ARG RUN_TESTS=1
RUN if [ "$RUN_TESTS" = "1" ]; then npm test; fi

# Configure npm global prefix to persist packages in /data volume
ENV NPM_CONFIG_PREFIX=/data/npm-global
ENV PATH="/data/npm-global/bin:${PATH}"

# Create data directories
RUN mkdir -p /data/db /data/config /data/memory/daily /data/skills /data/skills_agent /data/npm-global /workspace

# Copy built-in agent skills into image (seeded to /data/skills_agent on first run via entrypoint)
COPY data/skills_agent /app/skills_agent_defaults

# Persona seed files (seeded to /data/agents/<agentId> on first run via entrypoint)
COPY agents-seed /app/agents-seed

# Save baseline package snapshot for auto-tracking agent-installed packages
# Uses apt-mark showmanual to only capture explicitly installed packages,
# matching the tracking logic in track-packages.sh
RUN apt-mark showmanual | sort -u > /etc/dpkg-base-packages.txt

# Install apt hook to auto-track packages installed at runtime
COPY track-packages.sh /usr/local/bin/track-packages.sh
RUN chmod +x /usr/local/bin/track-packages.sh \
    && echo 'DPkg::Post-Invoke {"/usr/local/bin/track-packages.sh";};' \
       > /etc/apt/apt.conf.d/99track-packages

# Create non-root agent user with /workspace as home
ARG USERNAME=agent
ARG USER_UID=1000
ARG USER_GID=1000
RUN existing_user=$(getent passwd ${USER_UID} | cut -d: -f1) \
    && if [ -n "$existing_user" ] && [ "$existing_user" != "${USERNAME}" ]; then userdel -r "$existing_user" 2>/dev/null || true; fi \
    && existing_group=$(getent group ${USER_GID} | cut -d: -f1) \
    && if [ -n "$existing_group" ] && [ "$existing_group" != "${USERNAME}" ]; then groupmod -n ${USERNAME} "$existing_group"; else groupadd --force --gid ${USER_GID} ${USERNAME}; fi \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -d /workspace ${USERNAME} -s /bin/bash \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && chown -R ${USER_UID}:${USER_GID} /workspace /data

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# tini as PID 1: reaps orphaned processes and forwards signals.
# Without it npm becomes PID 1 and never calls wait() on foreign orphans,
# so every orphaned tool process (esbuild, chrome, ssh, ...) leaks as a zombie.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
