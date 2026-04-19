FROM node:22-alpine

WORKDIR /app

# Install native dependencies for robust image processing
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY . .

# Build the frontend static assets
RUN npm run build

# Ensure public/portraits folder exists so fs.writeFile doesn't crash
RUN mkdir -p public/portraits

EXPOSE 3001

CMD ["npm", "run", "start:server"]
