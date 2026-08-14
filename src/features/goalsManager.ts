import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import * as xlsx from 'xlsx';
import fetch from 'node-fetch';
import { supabase } from '../database/db';

export function setupGoalsManager(bot: Telegraf) {

  // 1. Upload e Leitura do Excel
  bot.on('document', async (ctx, next) => {
    const caption = ctx.message.caption || '';
    if (!caption.toLowerCase().includes('/uploadmetas')) {
      return next();
    }

    try {
      const doc = ctx.message.document;
      // Verifica se é Excel
      if (!doc.file_name?.endsWith('.xlsx') && !doc.file_name?.endsWith('.xls')) {
        return ctx.reply('Formato inválido. Por favor, envie um arquivo .xlsx ou .xls com o comando /uploadmetas na legenda.');
      }

      // Baixar arquivo
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.toString());
      const buffer = await response.arrayBuffer();

      // Ler Excel
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json<any>(worksheet, { header: 1 }); // Retorna matriz

      let count = 0;
      const chatId = ctx.chat.id.toString();

      // Começa da linha 1 (ignora cabeçalho na linha 0)
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length < 3) continue;

        const storeName = row[0]; // Coluna A: Loja
        let rawDate = row[1]; // Coluna B: Data
        const goalValue = row[2]; // Coluna C: Valor Meta
        
        if (!storeName || !rawDate || goalValue == null) continue;

        // Trata a data (Excel pode mandar como número serial ou string DD/MM/YYYY)
        let formattedDate = '';
        if (typeof rawDate === 'number') {
           const excelEpoch = new Date(1899, 11, 30);
           const dateObj = new Date(excelEpoch.getTime() + rawDate * 86400000);
           formattedDate = dateObj.toISOString().split('T')[0];
        } else if (typeof rawDate === 'string') {
           // Ex: 28/07/2026 -> 2026-07-28
           const parts = rawDate.split('/');
           if (parts.length === 3) {
             formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
           } else {
             formattedDate = rawDate; // Fallback
           }
        }

        await supabase.from('financial_goals').insert({
          chat_id: chatId,
          store_name: storeName.toString(),
          target_date: formattedDate,
          goal_value: goalValue.toString(),
          status: 'pendente'
        });
        count++;
      }

      await ctx.reply(`✅ Planilha processada com sucesso! Foram inseridas ${count} metas para este grupo.`);
      // Apagar o arquivo do grupo
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

    } catch (e) {
      console.error('Erro ao ler Excel:', e);
      ctx.reply('❌ Ocorreu um erro ao ler a planilha. Verifique se o formato está correto (Col A: Loja, Col B: Data DD/MM/YYYY, Col C: Meta).');
    }
  });

  // 2. Cron 08:00 - Postar a Meta do Dia e Cobrar a do Dia Anterior
  cron.schedule('0 8 * * *', async () => {
    try {
      const now = new Date();
      // "Hoje" em YYYY-MM-DD
      const todayOptions = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
      const todayStr = new Intl.DateTimeFormat('fr-CA', todayOptions).format(now); 

      // "Ontem" em YYYY-MM-DD
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = new Intl.DateTimeFormat('fr-CA', todayOptions).format(yesterday);

      // Grupos ativos
      const { data: groups } = await supabase.from('groups_config').select('chat_id').eq('active', true);
      if (!groups) return;

      for (const group of groups) {
        // --- POSTAR META DE HOJE ---
        const { data: todayGoals } = await supabase
          .from('financial_goals')
          .select('*')
          .eq('chat_id', group.chat_id)
          .eq('target_date', todayStr);

        if (todayGoals && todayGoals.length > 0) {
          for (const goal of todayGoals) {
            await bot.telegram.sendMessage(
              group.chat_id,
              `🎯 *BOM DIA!*\n\nA meta de vendas de hoje para a loja *${goal.store_name}* é de *R$ ${parseFloat(goal.goal_value).toLocaleString('pt-BR')}*.\nVamos pra cima!`,
              { parse_mode: 'Markdown' }
            );
          }
        }

        // --- COBRAR META DE ONTEM ---
        const { data: yesterdayGoals } = await supabase
          .from('financial_goals')
          .select('*')
          .eq('chat_id', group.chat_id)
          .eq('target_date', yesterdayStr)
          .is('achieved_value', null); // Ainda não preenchido

        if (yesterdayGoals && yesterdayGoals.length > 0) {
          for (const goal of yesterdayGoals) {
            const chargeMsg = await bot.telegram.sendMessage(
              group.chat_id,
              `📊 *FECHAMENTO DE ONTEM*\n\nGerência, qual foi o valor alcançado ontem (${yesterdayStr}) na loja *${goal.store_name}* (A meta era R$ ${goal.goal_value})?\n\n👉 *Responda esta mensagem* apenas com o número alcançado.`,
              { parse_mode: 'Markdown' }
            );
            // Salva o ID da mensagem de cobrança para escutar o reply
            await supabase.from('financial_goals').update({ charge_message_id: chargeMsg.message_id.toString() }).eq('id', goal.id);
          }
        }
      }
    } catch (error) {
      console.error('Erro no cron das 08h:', error);
    }
  }, { timezone: "America/Sao_Paulo" });

  // 3. Receber resposta do Gerente com o valor alcançado
  bot.on('message', async (ctx, next) => {
    const message = ctx.message;
    if (!message || !('reply_to_message' in message) || !message.reply_to_message) return next();
    if (!('text' in message)) return next();

    const replyToId = message.reply_to_message.message_id.toString();
    const chatId = ctx.chat.id.toString();

    // Buscar no banco se essa mensagem é uma cobrança de meta
    const { data: goals } = await supabase
      .from('financial_goals')
      .select('*')
      .eq('chat_id', chatId)
      .eq('charge_message_id', replyToId)
      .is('achieved_value', null);

    if (goals && goals.length > 0) {
      const goal = goals[0];
      
      // Verifica se é administrador
      if (ctx.chat.type !== 'private') {
         const admins = await ctx.getChatAdministrators();
         const isAdmin = admins.some(a => a.user.id === ctx.from.id);
         if (!isAdmin) {
            return ctx.reply('Apenas administradores podem registrar o valor alcançado da meta.');
         }
      }

      // Lê o valor digitado
      const textVal = message.text.replace(/[^\d.,]/g, '').replace(',', '.');
      const achieved = parseFloat(textVal);

      if (isNaN(achieved)) {
        return ctx.reply('❌ Por favor, responda com um valor numérico válido (ex: 5100.50).');
      }

      const target = parseFloat(goal.goal_value);
      const status = achieved >= target ? 'atingida' : 'nao_atingida';
      
      await supabase.from('financial_goals').update({
        achieved_value: achieved.toString(),
        status: status,
        charge_message_id: null // limpa para não processar de novo
      }).eq('id', goal.id);

      if (status === 'atingida') {
        await ctx.reply(`🎉 *PARABÉNS!* A loja ${goal.store_name} bateu a meta! Alcançado: R$ ${achieved.toLocaleString('pt-BR')}.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`💪 Meta não atingida na loja ${goal.store_name}, mas hoje é um novo dia! Alcançado: R$ ${achieved.toLocaleString('pt-BR')}.`, { parse_mode: 'Markdown' });
      }
    } else {
      return next();
    }
  });

}
