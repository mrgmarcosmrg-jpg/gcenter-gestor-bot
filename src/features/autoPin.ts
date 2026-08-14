import { Telegraf, Context } from 'telegraf';

export function registerAutoPin(bot: Telegraf) {
  bot.hears(/^\/fixar(?:@[\w_]+)?([\s\S]*)$/i, async (ctx) => {
    try {
      const message = ctx.message;
      if (!message || !('text' in message)) return;

      // Verifica se é um grupo
      if (ctx.chat.type === 'private') {
        await ctx.reply('Este comando só funciona em grupos.');
        return;
      }

      // Pega os administradores do grupo
      const admins = await ctx.getChatAdministrators();
      const isAdmin = admins.some(admin => admin.user.id === ctx.from.id);

      if (!isAdmin) {
        // Se não for admin, apaga a tentativa
        await ctx.deleteMessage(message.message_id).catch(() => {});
        return;
      }

      // Se a mensagem for respondendo a outra mensagem, fixa a mensagem respondida
      if (message.reply_to_message) {
        await ctx.pinChatMessage(message.reply_to_message.message_id);
        await ctx.deleteMessage(message.message_id).catch(() => {});
      } else {
        // Caso contrário, tenta fixar a própria mensagem (tirando o /fixar e opcionalmente o @bot)
        const textToPin = message.text.replace(/^\/fixar(?:@[\w_]+)?\s*/i, '').trim();
        if (textToPin) {
          // Edita a própria mensagem se tiver conteúdo? Não, o telegram não deixa o bot editar msg de terceiros.
          // O ideal é o bot reenviar e fixar.
          const sentMessage = await ctx.reply(textToPin);
          await ctx.pinChatMessage(sentMessage.message_id);
          await ctx.deleteMessage(message.message_id).catch(() => {});
        } else {
           await ctx.reply('Responda a uma mensagem com /fixar ou digite /fixar seguido do texto que deseja fixar.');
        }
      }
    } catch (error) {
      console.error('Erro ao processar /fixar:', error);
    }
  });
}
