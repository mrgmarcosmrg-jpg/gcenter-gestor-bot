import { Telegraf } from 'telegraf';
import { supabase } from '../database/db';

export function setupReturnsManager(bot: Telegraf) {

  // ==========================================
  // RASTREADOR DE MENSAGENS PARA ARQUIVO MORTO (DEVOLUÇÕES)
  // ==========================================
  bot.on('message', async (ctx, next) => {
    if (ctx.message && ctx.chat && ctx.message.message_thread_id) {
       const threadStr = ctx.message.message_thread_id.toString();
       
       const { data: ticket } = await supabase.from('returns_logs').select('id').eq('thread_id', threadStr).single();
       if (ticket) {
          await supabase.from('returns_messages').insert({
             return_id: ticket.id,
             chat_id: ctx.chat.id.toString(),
             message_id: ctx.message.message_id
          });
       }
    }
    return next();
  });

  // ==========================================
  // COMANDOS DE CONFIGURAÇÃO
  // ==========================================
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text) return next();
    const lowerText = text.toLowerCase();

    if (lowerText.includes('/setorfiscais')) {
      if (ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.getChatAdministrators();
        if (!admins.some(a => a.user.id === ctx.from.id)) return;
      } catch (e) {
        return ctx.reply('❌ O robô PRECISA ser Administrador deste grupo!');
      }
      await supabase.from('groups_config').upsert({ chat_id: ctx.chat.id.toString(), sector: 'fiscais', title: ctx.chat.title });
      return ctx.reply('✅ Este grupo foi configurado como o GRUPO DAS FISCAIS DE CAIXA (Devoluções).');
    }

    if (lowerText.includes('/setorauditoriadevolucoes')) {
      if (ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.getChatAdministrators();
        if (!admins.some(a => a.user.id === ctx.from.id)) return;
      } catch (e) {
        return ctx.reply('❌ O robô PRECISA ser Administrador deste grupo!');
      }
      await supabase.from('groups_config').upsert({ chat_id: ctx.chat.id.toString(), sector: 'auditoria_devolucoes', title: ctx.chat.title });
      return ctx.reply('📂 Este grupo foi configurado como o ARQUIVO DE AUDITORIA DE DEVOLUÇÕES.');
    }

    // ==========================================
    // CAPTURA DE TEXTOS DURANTE O PREENCHIMENTO
    // ==========================================
    if (ctx.message.message_thread_id && ctx.chat.type !== 'private') {
       const threadStr = ctx.message.message_thread_id.toString();
       const { data: ticket } = await supabase.from('returns_logs').select('*').eq('thread_id', threadStr).single();
       
       if (ticket && ctx.from.id !== bot.botInfo?.id) {
          
          if (ticket.status === 'draft_date') {
             await supabase.from('returns_logs').update({ purchase_date: text, status: 'draft_total' }).eq('id', ticket.id);
             return ctx.telegram.sendMessage(ctx.chat.id, `✅ **Data registrada:** ${text}\n\n📝 Passo 3: Qual o **VALOR TOTAL DO TICKET** de compra? (Ex: 150.50)`, { message_thread_id: parseInt(threadStr), parse_mode: 'Markdown' });
          }
          if (ticket.status === 'draft_total') {
             const val = text.replace(',', '.').replace(/[^0-9.]/g, '');
             await supabase.from('returns_logs').update({ total_receipt_value: parseFloat(val) || 0, status: 'draft_return_value' }).eq('id', ticket.id);
             return ctx.telegram.sendMessage(ctx.chat.id, `✅ **Valor total:** R$ ${val}\n\n📝 Passo 4: Qual o **VALOR DA DEVOLUÇÃO**? (Ex: 25.00)`, { message_thread_id: parseInt(threadStr), parse_mode: 'Markdown' });
          }
          if (ticket.status === 'draft_return_value') {
             const val = text.replace(',', '.').replace(/[^0-9.]/g, '');
             await supabase.from('returns_logs').update({ return_value: parseFloat(val) || 0, status: 'draft_products' }).eq('id', ticket.id);
             return ctx.telegram.sendMessage(ctx.chat.id, `✅ **Valor devolução:** R$ ${val}\n\n📝 Passo 5: Digite a **DESCRIÇÃO DOS PRODUTOS** devolvidos:`, { message_thread_id: parseInt(threadStr), parse_mode: 'Markdown' });
          }
          if (ticket.status === 'draft_products') {
             await supabase.from('returns_logs').update({ returned_products: text, status: 'draft_return_note' }).eq('id', ticket.id);
             return ctx.telegram.sendMessage(ctx.chat.id, `✅ **Produtos:** ${text}\n\n📸 Passo 6: Envie uma **FOTO** do contra-vale, nota de devolução ou procedimento no PDV.`, { message_thread_id: parseInt(threadStr), parse_mode: 'Markdown' });
          }
       }
    }

    return next();
  });

  // ==========================================
  // INÍCIO DO FLUXO (RECEBE A FOTO DO CUPOM)
  // ==========================================
  bot.on('photo', async (ctx, next) => {
    const chatId = ctx.chat.id.toString();
    const { data: group } = await supabase.from('groups_config').select('*').eq('chat_id', chatId).eq('sector', 'fiscais').single();
    if (!group) return next();

    // Se a foto já foi enviada dentro de uma thread (tópico ativo), e for o passo 6, vamos capturar
    if (ctx.message.message_thread_id) {
       const threadStr = ctx.message.message_thread_id.toString();
       const { data: ticket } = await supabase.from('returns_logs').select('*').eq('thread_id', threadStr).single();
       if (ticket && ticket.status === 'draft_return_note') {
          const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          await supabase.from('returns_logs').update({ return_note_photo_id: photoId, status: 'draft_video' }).eq('id', ticket.id);
          await ctx.telegram.sendMessage(chatId, `✅ **Foto da devolução salva!**\n\n🎥 Passo 7 (Final): Mande agora um **VÍDEO BOLINHA** (Video Note) mostrando o produto físico que foi devolvido.`, { message_thread_id: parseInt(threadStr), parse_mode: 'Markdown' });
          return next();
       }
       return next();
    }

    // Se for no grupo geral (fora de tópico), é um NOVO TICKET DE DEVOLUÇÃO
    const msgId = ctx.message.message_id.toString();
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const requesterName = ctx.from.first_name;

    const topicName = `🛒 Devolução - Em andamento`;
    const topic = await bot.telegram.createForumTopic(chatId, topicName).catch((e)=>{
        console.error('ERRO CRIAR TOPICO DEVOLUCAO', e);
        return null;
    });
    if (!topic) return next();
    
    const threadId = topic.message_thread_id.toString();

    const { data: newTicket } = await supabase.from('returns_logs').insert({
       chat_id: chatId, requester_name: requesterName, status: 'draft_store',
       receipt_photo_id: photoId, thread_id: threadId
    }).select().single();

    if (newTicket) {
       await bot.telegram.copyMessage(chatId, chatId, parseInt(msgId), { message_thread_id: parseInt(threadId) }).catch(()=>{});
       await bot.telegram.deleteMessage(chatId, parseInt(msgId)).catch(()=>{});
       
       // Buscar lojas para o teclado
       const { data: lojasConfig } = await supabase.from('groups_config').select('store_name').eq('sector', 'recebimento');
       const inline_keyboard: any[] = [];
       if (lojasConfig && lojasConfig.length > 0) {
          lojasConfig.forEach((l: any) => {
             if (l.store_name) {
                inline_keyboard.push([{ text: `🏬 ${l.store_name}`, callback_data: `ret_store_${newTicket.id}_${l.store_name}` }]);
             }
          });
       }

       await ctx.telegram.sendMessage(chatId, `🔄 **NOVA DEVOLUÇÃO INICIADA**\n\n📝 Passo 1: Selecione a loja onde a devolução ocorreu:`, {
         message_thread_id: parseInt(threadId),
         parse_mode: 'Markdown',
         reply_markup: { inline_keyboard }
       });
    }

    return next();
  });

  // ==========================================
  // SELEÇÃO DA LOJA (BOTÃO)
  // ==========================================
  bot.action(/^ret_store_(\d+)_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('Processando...').catch(()=>{});
      const ticketId = ctx.match[1];
      const storeName = ctx.match[2];
      
      const { data: ticket } = await supabase.from('returns_logs').select('*').eq('id', ticketId).single();
      if (!ticket || ticket.status !== 'draft_store') return;

      await supabase.from('returns_logs').update({ store_name: storeName, status: 'draft_date' }).eq('id', ticketId);
      await ctx.editMessageText(`✅ **Loja selecionada:** ${storeName}`, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(ctx.chat!.id, `📝 Passo 2: Digite a **DATA DA COMPRA** original (Ex: 15/08/2026):`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
    } catch (e: any) {
      console.error('ERRO ret_store:', e);
    }
  });

  // ==========================================
  // CAPTURA DO VÍDEO BOLINHA (FIM DO PREENCHIMENTO)
  // ==========================================
  bot.on('video_note', async (ctx, next) => {
    if (ctx.message.message_thread_id && ctx.chat.type !== 'private') {
       const threadStr = ctx.message.message_thread_id.toString();
       const { data: ticket } = await supabase.from('returns_logs').select('*').eq('thread_id', threadStr).single();
       
       if (ticket && ticket.status === 'draft_video') {
          const videoId = ctx.message.video_note.file_id;
          
          // Buscar gerente da loja
          const { data: loja } = await supabase.from('groups_config').select('manager_username').eq('store_name', ticket.store_name).eq('sector', 'recebimento').single();
          const managerMention = (loja && loja.manager_username) ? ` ${loja.manager_username}` : '';
          
          await supabase.from('returns_logs').update({ video_note_id: videoId, status: 'aguardando_gerente', manager_notified: true }).eq('id', ticket.id);
          
          const summary = `✅ **DEVOLUÇÃO PREENCHIDA E PRONTA PARA CONFERÊNCIA** ✅\n\n🏬 **Loja:** ${ticket.store_name}\n👤 **Fiscal:** ${ticket.requester_name}\n📅 **Data Compra:** ${ticket.purchase_date}\n💵 **Ticket Total:** R$ ${ticket.total_receipt_value}\n💰 **Devolução:** R$ ${ticket.return_value}\n📦 **Produtos:** ${ticket.returned_products}\n\n🚨 **ATENÇÃO GERENTE${managerMention}:**\nConfira as informações, as mídias acima, e encerre a devolução clicando abaixo.`;
          
          const inline_keyboard = [[{ text: '✅ Conferir e Fechar Devolução', callback_data: `close_return_${ticket.id}` }]];
          
          await ctx.telegram.sendMessage(ctx.chat.id, summary, { 
             message_thread_id: parseInt(threadStr), 
             parse_mode: 'Markdown',
             reply_markup: { inline_keyboard }
          });
       }
    }
    return next();
  });

  // ==========================================
  // FECHAMENTO PELO GERENTE
  // ==========================================
  bot.action(/^close_return_(\d+)$/, async (ctx) => {
     try {
        const ticketId = ctx.match[1];
        const resolverName = ctx.from.first_name;
        const { data: ticket } = await supabase.from('returns_logs').select('*').eq('id', ticketId).single();
        if (!ticket || ticket.status === 'resolvido') return await ctx.answerCbQuery('Ticket já encerrado!').catch(()=>{});

        // Só Gerentes (admin) podem fechar (ou o próprio dono do db config)
        try {
           const admins = await ctx.getChatAdministrators();
           if (!admins.some(a => a.user.id === ctx.from.id)) {
              return await ctx.answerCbQuery('⚠️ Apenas administradores (gerentes) podem fechar devoluções!', { show_alert: true }).catch(()=>{});
           }
        } catch (e) {}

        await ctx.answerCbQuery('Fechando e arquivando...').catch(()=>{});

        await supabase.from('returns_logs').update({ status: 'resolvido', resolved_by: resolverName, resolved_at: new Date().toISOString() }).eq('id', ticketId);
        
        const closedName = `📂 [ARQUIVADO] Devolução #${ticket.id} - ${ticket.store_name}`;
        
        // 1. Arquivar no Grupo de Auditoria de Devoluções
        const { data: auditGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'auditoria_devolucoes');
        if (auditGroups && auditGroups.length > 0) {
           const auditChatId = auditGroups[0].chat_id;
           const auditTopic = await bot.telegram.createForumTopic(auditChatId, closedName).catch(()=>null);
           
           if (auditTopic) {
              const auditThreadId = auditTopic.message_thread_id;
              
              const { data: history } = await supabase.from('returns_messages').select('*').eq('return_id', ticketId).order('id', { ascending: true });
              if (history && history.length > 0) {
                 for (const msg of history) {
                    await bot.telegram.copyMessage(auditChatId, msg.chat_id, msg.message_id, { message_thread_id: auditThreadId }).catch(()=>{});
                 }
              }

              const dossie = `📂 **DOSSIÊ DE AUDITORIA DE DEVOLUÇÃO #${ticket.id}**\n\n🏬 **Loja:** ${ticket.store_name}\n👤 **Fiscal:** ${ticket.requester_name}\n📅 **Data Compra:** ${ticket.purchase_date}\n💵 **Ticket Total:** R$ ${ticket.total_receipt_value}\n💰 **Valor Devolvido:** R$ ${ticket.return_value}\n📦 **Produtos:** ${ticket.returned_products}\n\n✅ **Conferido e Fechado por:** ${resolverName}\n📅 **Fechamento:** ${new Date().toLocaleString('pt-BR')}`;
              await bot.telegram.sendMessage(auditChatId, dossie, { message_thread_id: auditThreadId, parse_mode: 'Markdown' }).catch(()=>{});
              await bot.telegram.closeForumTopic(auditChatId, auditThreadId).catch(()=>{});
           }
        }

        // 2. Apagar o Tópico original das Fiscais
        if (ticket.chat_id && ticket.thread_id) {
           await bot.telegram.deleteForumTopic(ticket.chat_id, parseInt(ticket.thread_id)).catch(()=>{});
        }
     } catch (e) {
        console.error('ERRO FECHAR DEVOLUÇÃO', e);
     }
  });

}
