import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';

export function registerEscalation(bot: Telegraf) {
  // Comando para iniciar uma dúvida direcionada
  bot.hears(/^\/duvida(?:@[\w_]+)?\s+(@\w+)\s+(.+)$/i, async (ctx) => {
    try {
      const match = ctx.message.text.match(/^\/duvida(?:@[\w_]+)?\s+(@\w+)\s+(.+)$/i);
      if (!match) return;

      const targetUser = match[1];
      const questionText = match[2];

      // Salva a dúvida no banco
      await supabase.from('pending_questions').insert({
        chat_id: ctx.chat.id.toString(),
        message_id: ctx.message.message_id.toString(),
        asker_id: ctx.from.id.toString(),
        asker_name: ctx.from.first_name,
        target_user: targetUser,
        question_text: questionText,
        resolved: false,
        created_at: new Date().toISOString()
      });

      await ctx.reply(`${targetUser}, você tem uma dúvida de ${ctx.from.first_name}. Responda esta mensagem para marcar como resolvida.`);
    } catch (error) {
      console.error('Erro ao registrar dúvida:', error);
    }
  });

  // Escuta todas as mensagens para ver se é uma resposta a uma dúvida pendente
  bot.on('message', async (ctx, next) => {
    const message = ctx.message;
    if (!message || !('reply_to_message' in message) || !message.reply_to_message) return next();

    const replyToId = message.reply_to_message.message_id.toString();
    const chatId = ctx.chat.id.toString();

    // Verifica se a mensagem respondida é uma dúvida pendente
    const { data: questions } = await supabase
      .from('pending_questions')
      .select('*')
      .eq('chat_id', chatId)
      .eq('message_id', replyToId)
      .eq('resolved', false);

    if (questions && questions.length > 0) {
      // Marca como resolvida
      await supabase
        .from('pending_questions')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('id', questions[0].id);

      await ctx.reply('✅ Dúvida marcada como resolvida!', {
        reply_parameters: { message_id: message.message_id }
      });
    }
    
    return next();
  });

  // Cron job para escalonamento (roda a cada 10 minutos)
  cron.schedule('*/10 * * * *', async () => {
    // Escalar dúvidas com mais de 60 minutos sem resposta
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - 60);

    const { data: pending } = await supabase
      .from('pending_questions')
      .select('*')
      .eq('resolved', false)
      .eq('escalated', false)
      .lt('created_at', cutoffTime.toISOString());

    if (!pending) return;

    for (const q of pending) {
      try {
        await bot.telegram.sendMessage(
          q.chat_id, 
          `⚠️ Atenção gerência! A dúvida direcionada a ${q.target_user} (por ${q.asker_name}) está sem resposta há mais de 1 hora.`,
          {
            reply_parameters: { message_id: parseInt(q.message_id) }
          }
        );
        // Marca como escalada
        await supabase.from('pending_questions').update({ escalated: true }).eq('id', q.id);
      } catch (e) {
        console.error('Erro ao escalar:', e);
      }
    }
  });
}
