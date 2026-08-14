import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';

export function setupSummaries(bot: Telegraf) {
  // Configura um resumo diário às 19:00 (fim do expediente) para todos os grupos ativos
  cron.schedule('0 19 * * 1-5', async () => {
    try {
      const { data: groups } = await supabase.from('groups_config').select('*').eq('active', true);
      if (!groups) return;

      for (const group of groups) {
        // Busca dúvidas não resolvidas do grupo
        const { data: pending } = await supabase
          .from('pending_questions')
          .select('*')
          .eq('chat_id', group.chat_id)
          .eq('resolved', false);

        if (pending && pending.length > 0) {
          let summaryMsg = '📊 *Resumo de Pendências do Dia*\n\n';
          summaryMsg += `Temos ${pending.length} dúvida(s) ainda em aberto:\n\n`;

          pending.forEach((q, i) => {
            summaryMsg += `${i + 1}. De ${q.asker_name} para ${q.target_user}: "${q.question_text}"\n`;
          });

          summaryMsg += '\nPor favor, respondam às mensagens originais para baixá-las do sistema antes de encerrar o expediente.';

          await bot.telegram.sendMessage(group.chat_id, summaryMsg, { parse_mode: 'Markdown' });
        }
      }
    } catch (e) {
      console.error('Erro ao gerar resumo diário:', e);
    }
  }, {
    timezone: "America/Sao_Paulo"
  });
}
