# Agent Room — hosted server image.
# The app is a single Node script with no third-party dependencies, so the
# image is just the runtime plus the script. It runs as the SERVER (`serve`),
# binding 0.0.0.0 inside the container; expose it only through a reverse proxy.
FROM node:22-alpine

WORKDIR /app
COPY scripts/agent_room.mjs /app/agent_room.mjs

# Persistent room state lives here; mount a volume over it.
# The built-in non-root `node` user (uid 1000) owns it.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

ENV AGENT_ROOM_HOME=/data \
    AGENT_ROOM_BIND_HOST=0.0.0.0 \
    AGENT_ROOM_PORT=7331
# AGENT_ROOM_PUBLIC_URL is supplied at run time (e.g. https://arh.schmitzplex.com).

EXPOSE 7331
USER node

# Liveness: the server answers /api/health on loopback inside the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENT_ROOM_PORT||7331)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/agent_room.mjs", "serve"]
