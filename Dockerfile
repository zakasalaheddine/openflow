# Secondary to `npx openflow-studio`. Here for the hosted demo and for anyone
# who would rather not install Node — not the recommended path for local use,
# because the whole point is that your assets and your fal key stay on your
# machine, and a container makes that a mount you have to remember.
FROM node:22-slim

# ffmpeg is a real dependency for video and clip export, not an optional extra.
# The image carries it so the container never hits the "install ffmpeg" error a
# local install can recover from.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first: they change far less often than the source, so a source
# edit does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# The database and generated assets belong on a volume; without one they die
# with the container, and every render has to be paid for again.
ENV OPENFLOW_DATA_DIR=/data
ENV OPENFLOW_EXPORTS_DIR=/exports
VOLUME ["/data", "/exports"]

EXPOSE 3000
# No FAL_KEY baked in. Pass it at run time, or run with DEMO=1 for the
# fixture-backed demo that dispatches nothing.
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
