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

dotenv.config();

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ ERRO: BOT_TOKEN não configurado no arquivo .env');
  process.exit(1);
}

const bot = new Telegraf(token);

// Comando para limpar teclados antigos presos na tela
bot.command('limpar', async (ctx) => {
  await ctx.reply('🧹 Limpando botões antigos da tela...', {
    reply_markup: { remove_keyboard: true }
  });
});

// Prova de vida
bot.start(async (ctx) => {
  await ctx.reply('🤖 Olá, Marcos! Eu estou VIVO e operando 100%! O meu sistema interno de atualizações foi concluído. Pode contar comigo!');
});

// Middleware para logging simples de interações
bot.use(async (ctx, next) => {
  const start = new Date();
  console.log(`\n--- NOVO UPDATE RECEBIDO: ${ctx.updateType} ---`);
  console.log(JSON.stringify(ctx.update, null, 2));
  
  await next();
  const ms = new Date().getTime() - start.getTime();
  console.log(`[${new Date().toISOString()}] Update ${ctx.updateType} processado em ${ms}ms`);
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

// Inicia o bot
async function start() {
  await setupDatabase();
  
  // Configura o botão de "Menu" do Telegram com os comandos (sem await para não travar)
  bot.telegram.setMyCommands([
    { command: 'duvida', description: 'Fazer uma pergunta direcionada (@usuario texto)' },
    { command: 'fixar', description: 'Fixar uma mensagem importante (Admin)' },
    { command: 'horario', description: 'Configurar horário do grupo (Admin)' }
  ]).catch(err => console.error('Erro ao configurar menu de comandos:', err));

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
