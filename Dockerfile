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


CMD ["node", "server.js"]
