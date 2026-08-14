import { Telegraf } from 'telegraf';

export function registerReactionIncentive(bot: Telegraf) {
  // Palavras-chave que indicam confirmação simples
  const confirmationWords = ['ok', 'recebido', 'entendido', 'blz', 'beleza', 'ciente', 'fechado'];

  bot.on('message', async (ctx, next) => {
    try {
      const message = ctx.message;
      if (!message || !('text' in message)) {
        return next();
      }

      // Se for comando, ignora
      if (message.text.startsWith('/')) {
        return next();
      }

      const text = message.text.toLowerCase().trim();
      
      // Verifica se a mensagem é apenas uma palavra de confirmação
      if (confirmationWords.includes(text)) {
        // Envia mensagem instrutiva
        const reply = await ctx.reply(
          '💡 Dica: Para confirmar leitura ou recebimento, prefira usar as reações (👍, ❤️, etc) na mensagem original em vez de mandar um "ok". Isso evita notificações desnecessárias e ajuda na comunicação!',
          { reply_parameters: { message_id: message.message_id } }
        );

        // Apaga a mensagem instrutiva após 15 segundos para não poluir o grupo
        setTimeout(async () => {
          try {
            await ctx.deleteMessage(reply.message_id);
          } catch (e) {
            // Ignora se não conseguir apagar (ex: bot sem permissão)
          }
        }, 15000);
      }
    } catch (e) {
      console.error('Erro no reactionIncentive:', e);
    }
    
    return next();
  });
}
