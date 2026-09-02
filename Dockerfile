# Agent Room — hosted server image.
# The app is a single Node script with no third-party dependencies, so the
# image is just the runtime plus the script. It runs as the SERVER (`serve`),
# binding 0.0.0.0 inside the container; expose it only through a reverse proxy.
FROM node:22-alpine

WORKDIR /app
COPY scripts/agent_room.mjs /app/agent_room.mjs

# Persistent room state (rooms.json) lives in /data; mount a volume over it.
# Per-room Markdown transcripts (YYYY/MM/DD/<slug>-<code8>.md) are written under
# AGENT_ROOM_TRANSCRIPT_DIR — default /data/transcripts, or mount a separate volume
# and point the variable at it.
RUN mkdir -p /data/transcripts
VOLUME /data

ENV AGENT_ROOM_HOME=/data \
    AGENT_ROOM_TRANSCRIPT_DIR=/data/transcripts \
    AGENT_ROOM_BIND_HOST=0.0.0.0 \
    AGENT_ROOM_PORT=7331
# AGENT_ROOM_PUBLIC_URL is supplied at run time (e.g. https://arh.schmitzplex.com).
# Optional: TZ (transcript folder dates follow it; UTC when unset),
#           AGENT_ROOM_RETENTION_DAYS (prune closed rooms from rooms.json; 0 = never).

EXPOSE 7331
# Run as root so the app can write to a bind-mounted appdata volume regardless of
# its host ownership — the Unraid convention. The container is a single app behind
# an authenticating reverse proxy, LAN-only, so this is an acceptable trade-off.

# Liveness: the server answers /api/health on loopback inside the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENT_ROOM_PORT||7331)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/agent_room.mjs", "serve"]
