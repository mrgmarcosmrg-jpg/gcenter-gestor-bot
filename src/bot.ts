import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { setupDatabase } from './database/db';
import { registerAutoPin } from './features/autoPin';
import { registerReactionIncentive } from './features/reactionIncentive';
import { registerEscalation } from './features/escalation';
import { setupSilenceManager } from './features/silenceManager';
import { setupSummaries } from './features/summaries';

import { setupGoalsManager } from './features/goalsManager';
import { setupInvoiceAuditor } from './features/invoiceAuditor';
import { setupReportsManager } from './features/reportsManager';
import { setupCultureManager } from './features/cultureManager';
import { setupGatekeeper } from './features/gatekeeper';
import { setupReturnsManager } from './features/returnsManager';

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ ERRO: BOT_TOKEN não configurado no arquivo .env');
  process.exit(1);
}

const bot = new Telegraf(token);

// Wrapper global na API do Telegram para tratar Rate Limit (Erro 429) e quedas rápidas de rede automaticamente
const originalCallApi = bot.telegram.callApi.bind(bot.telegram);
(bot.telegram as any).callApi = async function (method: string, payload: any, callOpts?: any) {
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await originalCallApi(method as any, payload, callOpts);
    } catch (err: any) {
      const errorCode = err?.response?.error_code;
      const description = err?.response?.description || err?.message || '';

      // Ignora silenciosamente se a mensagem para editar/deletar já não existir
      if (errorCode === 400 && (description.includes('message is not modified') || description.includes('message to edit not found'))) {
        throw err;
      }

      // Se for Erro 429 (Too Many Requests), aguarda o tempo exigido pelo Telegram e tenta de novo
      if (errorCode === 429 && attempt < maxRetries) {
        const retryAfter = (err?.response?.parameters?.retry_after || 15) + 1;
        console.warn(`⏳ [Telegram 429] Limite de envios atingido no método "${method}". Aguardando ${retryAfter}s para reenviar (Tentativa ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      // Se for falha temporária de rede/socket, aguarda 2s e tenta novamente
      const isNetworkError = !errorCode && (
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ENOTFOUND' ||
        err?.code === 'EAI_AGAIN' ||
        description.includes('socket hang up') ||
        description.includes('fetch failed') ||
        description.includes('network')
      );
      if (isNetworkError && attempt < maxRetries) {
        console.warn(`🌐 [Rede] Oscilação ao chamar "${method}". Retentando em ${attempt * 2}s (Tentativa ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }

      throw err;
    }
  }
};

// Comando para limpar teclados antigos presos na tela
bot.command('limpar', async (ctx) => {
  await ctx.reply('🧹 Limpando botões antigos da tela...', {
    reply_markup: { remove_keyboard: true }
  });
});

// Prova de vida
bot.start(async (ctx) => {
  const userName = ctx.from?.first_name || 'Membro da Equipe';
  await ctx.reply(`🤖 Olá, ${userName}! Eu sou o GCenter Gestor Bot, estou VIVO e operando 100% no servidor interno.\n\nVocê já tem meu contato ativado no privado. Pode contar comigo!`);
});

// Global error handler to prevent crashes
bot.catch((err, ctx) => {
  console.error(`❌ ERRO GLOBAL [${ctx.updateType}]:`, err);
});

// Middleware para logging simples de interações
bot.use(async (ctx, next) => {
  const start = new Date();
  // console.log(`\n--- NOVO UPDATE RECEBIDO: ${ctx.updateType} ---`);
  
  try {
    await next();
  } catch (err) {
    console.error('Erro no fluxo principal (capturado pelo middleware):', err);
  }
  
  const ms = new Date().getTime() - start.getTime();
  // console.log(`[${new Date().toISOString()}] Update ${ctx.updateType} processado em ${ms}ms`);
});

// Inicialização das funcionalidades
registerAutoPin(bot);
registerReactionIncentive(bot);
registerEscalation(bot);
setupSilenceManager(bot);
setupSummaries(bot);
setupGoalsManager(bot);
setupInvoiceAuditor(bot);
setupReportsManager(bot);
setupCultureManager(bot);
setupGatekeeper(bot);
setupReturnsManager(bot);

// Inicia o bot
async function start() {
  await setupDatabase();
  
  // ==========================================
  // DUMMY HTTP SERVER PARA O RENDER (PLANO GRÁTIS)
  // O Render exige que um "Web Service" escute numa porta
  // ==========================================
  const http = require('http');
  const port = process.env.PORT || 3000;
  http.createServer((req: any, res: any) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Bot do GCenter esta rodando perfeitamente!');
    res.end();
  }).listen(port, () => {
    console.log(`🌐 Servidor HTTP fake escutando na porta ${port} para o Render...`);
  });
  
  // Configura o botão de "Menu" do Telegram com os comandos (sem await para não travar)
  bot.telegram.setMyCommands([
    { command: 'duvida', description: 'Fazer uma pergunta direcionada (@usuario texto)' },
    { command: 'fixar', description: 'Fixar uma mensagem importante (Admin)' },
    { command: 'horario', description: 'Configurar horário do grupo (Admin)' }
  ]).catch(err => console.error('Erro ao configurar menu de comandos:', err));

  // Remove qualquer Webhook antigo que tenha ficado preso no Telegram (ex: da época do Supabase)
  // Removemos o webhook antigo caso exista, mas mantemos as mensagens pendentes para não perder tickets
  try {
     await bot.telegram.deleteWebhook({ drop_pending_updates: false });
     console.log('🧹 Webhook antigo limpo com sucesso.');
  } catch (err) {
     console.error('Aviso ao limpar webhook:', err);
  }

  bot.launch({
    allowedUpdates: ['message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request', 'channel_post', 'edited_message']
  }).then(() => {
    console.log('🚀 GCenter Gestor rodando...');
  }).catch(err => {
    console.error('❌ Erro ao iniciar o bot:', err);
  });
}

start();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
