FROM node:18

# Instalar dependências + Firebird client + ferramentas de rede
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libfbclient2 \
    firebird-dev \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Criar script de entrada que configura DNS antes de iniciar
RUN echo '#!/bin/bash\n\
echo "Configurando DNS..."\n\
echo "nameserver 8.8.8.8" > /etc/resolv.conf\n\
echo "nameserver 8.8.4.4" >> /etc/resolv.conf\n\
echo "options ndots:0" >> /etc/resolv.conf\n\
echo "DNS configurado:"\n\
cat /etc/resolv.conf\n\
echo "Iniciando aplicação..."\n\
node dist/server.js' > /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

RUN npm run build

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]

# FROM node:18

# # Instalar dependências + Firebird client
# RUN apt-get update && apt-get install -y \
#     python3 \
#     make \
#     g++ \
#     libfbclient2 \
#     firebird-dev

# WORKDIR /app

# COPY package*.json ./

# RUN npm install

# COPY . .

# RUN npm run build

# EXPOSE 3000

# CMD ["npm", "run", "start"]