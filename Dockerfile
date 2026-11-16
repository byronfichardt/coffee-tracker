FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=80 \
    STORAGE_DIR=/storage

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# /storage only ever holds an optional config.json; all coffee data stays on the phone.
RUN mkdir -p /storage && chown node:node /storage
VOLUME /storage

USER node
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/up" || exit 1

CMD ["node", "server.js"]
