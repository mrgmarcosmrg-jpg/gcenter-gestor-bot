#!/bin/bash

echo "=========================================="
echo "🚀 INICIANDO DEPLOY DO GCENTER GESTOR BOT"
echo "=========================================="

echo "⬇️  1. Puxando as atualizações mais recentes do GitHub..."
git pull origin main

echo "🔨 2. Reconstruindo o container e aplicando as mudanças..."
docker compose up -d --build gcenter-gestor-bot

echo "✅ DEPLOY CONCLUÍDO COM SUCESSO! O robô está atualizado e rodando."
echo "=========================================="
