FROM node:22-alpine

WORKDIR /app
COPY package.json server.js identity.js tokens.js deploy.js ./

ENV PORT=8080 TOKEN_DATA_DIR=/data NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8080

USER node
CMD ["node", "server.js"]
