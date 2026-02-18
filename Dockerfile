# Use Node 18 LTS Alpine
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

# Expose default Railway port
EXPOSE 8080

# Start app
CMD ["npm", "start"]
