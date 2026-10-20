# The WAVS Dashboard website in a container (Railway, Fly.io, any Docker host). See docs/HOSTING.md.
# Needs MONGODB_URI and WAVS_OWNER_EMAIL; the host sets PORT.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV WAVS_HOSTED=1 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]
