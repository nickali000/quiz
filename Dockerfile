FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=1111
EXPOSE 1111

CMD ["npm", "start"]
