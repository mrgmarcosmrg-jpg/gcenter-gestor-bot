#!/bin/bash

echo "=========================================="
echo "🚀 INICIANDO DEPLOY DO GCENTER GESTOR BOT"
echo "=========================================="

echo "⬇️  1. Puxando as atualizações mais recentes do GitHub..."
git pull origin main

echo "🔨 2. Reconstruindo o container na pasta mestre da infraestrutura..."
# Volta para a pasta mestre (gcenter-infra) onde fica o docker-compose.yml e roda o build
cd ..
docker compose up -d --build gcenter-gestor-bot

echo "✅ DEPLOY CONCLUÍDO COM SUCESSO! O robô está atualizado e rodando."
echo "=========================================="
