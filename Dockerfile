FROM node:22-alpine
RUN apk add --no-cache git

WORKDIR /app
COPY server.js package.json ./
COPY public ./public
COPY seed ./seed

ENV DATA_DIR=/data PORT=4747 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 4747

USER node
CMD ["node", "server.js"]
