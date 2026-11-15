FROM node:22-bookworm-slim

WORKDIR /app

# Native build tools are installed INSIDE Render's Linux build container,
# so Windows users do not need Visual Studio C++ Build Tools.
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
