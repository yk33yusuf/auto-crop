FROM node:18-alpine

WORKDIR /app

# Package files'ı kopyala
COPY package*.json ./

# Dependencies'i kur
RUN npm install --production

# Uygulama dosyalarını kopyala
COPY . .

# uploads klasörünü oluştur
RUN mkdir -p uploads

# Port expose et
EXPOSE 3000

# Uygulamayı başlat
CMD ["node", "improved-server.js"]
