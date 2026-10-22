FROM node:24-alpine
WORKDIR /app

# Instala solo dependencias de producción (reproducibilidad exacta vía lockfile)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto del código fuente
COPY . .

EXPOSE 4000
CMD ["npm", "start"]
