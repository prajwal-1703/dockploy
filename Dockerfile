FROM node:24-alpine

COPY package.json package-lock.json ./

RUN npm install

COPY server.js ./


EXPOSE 8080

CMD ["npm", "run", "start"]