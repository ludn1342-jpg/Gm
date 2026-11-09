# Usamos una imagen ligera de Node
FROM node:20-slim

# 1. Instalar las dependencias de Chromium para Puppeteer
# Estas son las librerías que Render no te deja instalar en el entorno nativo
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Configurar variables de entorno para Puppeteer
# Le decimos que NO descargue Chrome (porque ya lo instalamos arriba)
# y le indicamos dónde está el ejecutable del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 3. Directorio de trabajo
WORKDIR /app

# 4. Copiar archivos de dependencias e instalar
COPY package*.json ./
RUN npm install

# 5. Copiar el resto del código (server.js, index3.html, etc.)
COPY . .

# 6. Exponer el puerto (Render lo detecta automáticamente, pero es buena práctica)
EXPOSE 3001

# 7. Comando de inicio
CMD ["npm", "start"]
