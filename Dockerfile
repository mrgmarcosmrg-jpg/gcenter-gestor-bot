# Usa a imagem oficial do Node.js (versão 20 recomendada para este projeto)
FROM node:20-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependência primeiro (para aproveitar o cache do Docker)
COPY package*.json ./

# Instala as dependências de produção e de build (typescript)
RUN npm install

# Copia todo o resto do código da aplicação
COPY . .

# Faz o build (transpila TypeScript para JS)
RUN npm run build

# Remove as dependências de dev para manter a imagem leve
RUN npm prune --production

# O bot expõe um servidor HTTP na porta 3000 para healthcheck
EXPOSE 3000

# Comando para rodar a aplicação em produção
CMD ["npm", "start"]
