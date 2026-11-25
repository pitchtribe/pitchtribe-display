FROM node:22-bookworm-slim
ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL io.hass.type="app" io.hass.version="${BUILD_VERSION}" io.hass.arch="${BUILD_ARCH}"
WORKDIR /opt/pitchtribe
COPY source/signage-server ./signage-server
COPY source/app ./app
RUN cd app && npm ci --omit=dev && npm cache clean --force
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data/pitchtribe
WORKDIR /opt/pitchtribe/app
EXPOSE 8080
CMD ["node", "server.js"]
