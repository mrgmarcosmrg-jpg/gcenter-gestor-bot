import { Telegraf, Context } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';

export function setupInvoiceAuditor(bot: Telegraf) {

  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text) return next();
    const lowerText = text.toLowerCase();

    if (lowerText.includes('/setorfaturamento')) {
      if (ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.getChatAdministrators();
        if (!admins.some(a => a.user.id === ctx.from.id)) return;
      } catch (e) {
        return ctx.reply('❌ O robô PRECISA ser Administrador deste grupo!');
      }
      await supabase.from('groups_config').upsert({ chat_id: ctx.chat.id.toString(), sector: 'faturamento', title: ctx.chat.title });
      return ctx.reply('✅ Este grupo foi configurado como a CENTRAL DE FATURAMENTO.');
    }

    if (lowerText.includes('/setorrecebimento')) {
      if (ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.getChatAdministrators();
        if (!admins.some(a => a.user.id === ctx.from.id)) return;
      } catch (e) {
        return ctx.reply('❌ O robô PRECISA ser Administrador deste grupo!');
      }
      const parts = lowerText.split(/setorrecebimento/i);
      const storeName = parts[1] ? parts[1].trim() : '';
      if (!storeName) return ctx.reply('❌ Falta o nome da loja. Ex: /setorrecebimento Loja Matriz');

      await supabase.from('groups_config').upsert({ chat_id: ctx.chat.id.toString(), sector: 'recebimento', store_name: storeName, title: ctx.chat.title });
      return ctx.reply(`✅ Recebimento configurado para: *${storeName}*.`, { parse_mode: 'Markdown' });
    }

    if (lowerText.includes('/gerente')) {
      if (ctx.chat.type === 'private') return;
      const parts = lowerText.split(/gerente/i);
      const username = parts[1] ? parts[1].trim() : '';
      if (!username || !username.startsWith('@')) return ctx.reply('❌ Faltou o nome do gerente. Ex: /gerente @JoaoSilva');
      await supabase.from('groups_config').update({ manager_username: username }).eq('chat_id', ctx.chat.id.toString());
      return ctx.reply(`✅ Gerente desta loja configurado para: ${username}`);
    }

    return next();
  });

  // ==========================================
  // PONTE DE COMUNICAÇÃO BIDIRECIONAL NOS TÓPICOS
  // ==========================================
  bot.on('message', async (ctx, next) => {
    if (!ctx.chat || !ctx.message || !ctx.from) return next();
    if (ctx.from.id === bot.botInfo?.id) return next();

    const chatId = ctx.chat.id.toString();
    const { data: group } = await supabase.from('groups_config').select('*').eq('chat_id', chatId).single();
    if (!group) return next();

    const text = ('text' in ctx.message ? ctx.message.text : ('caption' in ctx.message ? ctx.message.caption : '')) || '';
    if (text.startsWith('/')) return next();

    // FATURAMENTO -> RECEBIMENTO
    if (group.sector === 'faturamento' && ctx.message.message_thread_id) {
      const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('thread_id', ctx.message.message_thread_id.toString()).single();
      
      if (ticket && ticket.status === 'aguardando_justificativa') {
         if ('text' in ctx.message) {
            const justificativa = ctx.message.text;
            const resolverName = ticket.resolved_by || ctx.from.first_name;
            const conclusion = ticket.conclusion_status;

            await supabase.from('receiving_logs').update({ 
               status: 'resolvido', 
               conclusion_observation: justificativa,
               resolved_at: new Date().toISOString() 
            }).eq('id', ticket.id);

            await ctx.reply(`✅ Justificativa salva. Ticket finalizado com status: ${conclusion}!`);

            // Fechar faturamento
            if (ticket.thread_id) {
               const op = (ticket.operation_type || 'COMPRA').toUpperCase();
               const closedName = `✅ Ticket #${ticket.id} - ${ticket.supplier} [${op}]`;
               await bot.telegram.editForumTopic(ctx.chat.id, parseInt(ticket.thread_id), { name: closedName }).catch(()=>{});
               await bot.telegram.closeForumTopic(ctx.chat.id, parseInt(ticket.thread_id)).catch(()=>{});
            }

            // Fechar recebimento
            if (ticket.chat_id && ticket.recebimento_thread_id) {
               const msg = `✅ *TICKET CONCLUÍDO*\nFinalizado por *${resolverName}*\n\n📌 **Status:** ${conclusion}\n📝 **Observação/Ressalva:** ${justificativa}\n\nA conversa foi encerrada.`;
               
               const { data: grp } = await supabase.from('groups_config').select('manager_username').eq('chat_id', ticket.chat_id).single();
               let finalMsg = msg;
               if (ticket.operation_type === 'transferencia' && ticket.type === 'divergencia' && grp?.manager_username) {
                  finalMsg = `${msg}\n\n🚨 **Ciente ${grp.manager_username}? Acompanhamento finalizado.**`;
               }
               await bot.telegram.sendMessage(ticket.chat_id, finalMsg, {
                  message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown'
               }).catch(()=>{});
               var op = (ticket.operation_type || 'COMPRA').toUpperCase();
               var closedName = `✅ Ticket #${ticket.id} - ${ticket.supplier} [${op}]`;
               await bot.telegram.editForumTopic(ticket.chat_id, parseInt(ticket.recebimento_thread_id), { name: closedName }).catch(()=>{});
               await bot.telegram.closeForumTopic(ticket.chat_id, parseInt(ticket.recebimento_thread_id)).catch(()=>{});

            }
         } else {
            await ctx.reply('⚠️ Por favor, digite a justificativa em forma de TEXTO.');
         }
         return next();
      }

      if (ticket && ticket.chat_id && ticket.recebimento_thread_id && ticket.status !== 'resolvido') {
        const senderName = ctx.from.first_name;
        if ('text' in ctx.message) {
           await bot.telegram.sendMessage(ticket.chat_id, `👩‍💻 *${senderName}:*\n${ctx.message.text}`, {
              message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown'
           });
        } else if ('photo' in ctx.message) {
           const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
           await bot.telegram.sendPhoto(ticket.chat_id, photoId, {
              caption: `👩‍💻 *${senderName}:*\n${text}`, message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown'
           });
        } else if ('video_note' in ctx.message) {
           const fileId = ctx.message.video_note.file_id;
           await bot.telegram.sendVideoNote(ticket.chat_id, fileId, { message_thread_id: parseInt(ticket.recebimento_thread_id) });
        } else if ('video' in ctx.message) {
           const fileId = ctx.message.video.file_id;
           await bot.telegram.sendVideo(ticket.chat_id, fileId, { caption: `👩‍💻 *${senderName}:*\n${text}`, message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown' });
        } else if ('voice' in ctx.message) {
           const fileId = ctx.message.voice.file_id;
           await bot.telegram.sendVoice(ticket.chat_id, fileId, { caption: `👩‍💻 *${senderName}:*\n${text}`, message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown' });
        } else if ('document' in ctx.message) {
           const fileId = ctx.message.document.file_id;
           await bot.telegram.sendDocument(ticket.chat_id, fileId, { caption: `👩‍💻 *${senderName}:*\n${text}`, message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown' });
        }

        if (ticket.status === 'aguardando_bono') {
           await supabase.from('receiving_logs').update({ status: 'em_andamento' }).eq('id', ticket.id);
           const msg = await bot.telegram.sendMessage(ctx.chat.id, `✅ **BONO REGISTRADO!**\n\nFaturista, agora você já pode passar a bola para a Analista de Faturamento:`, {
              message_thread_id: ctx.message.message_thread_id,
              parse_mode: 'Markdown',
              reply_markup: {
                 inline_keyboard: [[{ text: `✅ Bono Criado (Passar p/ Analista)`, callback_data: `bono_sent_${ticket.id}` }]]
              }
           });
           await bot.telegram.pinChatMessage(ctx.chat.id, msg.message_id).catch(()=>{});
        }
      }
      return next();
    }

    // RECEBIMENTO -> FATURAMENTO
    if (group.sector === 'recebimento' && ctx.message.message_thread_id) {
      const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('recebimento_thread_id', ctx.message.message_thread_id.toString()).single();
      if (ticket && ticket.thread_id && ticket.status !== 'resolvido') {
         const { data: fatGroups } = await supabase.from('groups_config').select('*').eq('sector', 'faturamento');
         if (fatGroups && fatGroups.length > 0) {
             const faturamentoChatId = fatGroups[0].chat_id;
             const senderName = ctx.from.first_name;
             
             if ('text' in ctx.message) {
                await bot.telegram.sendMessage(faturamentoChatId, `👷‍♂️ *${senderName} (Loja):*\n${ctx.message.text}`, {
                   message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown'
                });
             } else if ('photo' in ctx.message) {
                const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await bot.telegram.sendPhoto(faturamentoChatId, photoId, {
                   caption: `👷‍♂️ *${senderName} (Loja):*\n${text}`, message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown'
                });
             } else if ('video' in ctx.message) {
                const fileId = ctx.message.video.file_id;
                await bot.telegram.sendVideo(faturamentoChatId, fileId, { caption: `👷‍♂️ *${senderName} (Loja):*\n${text}`, message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown' });
             } else if ('voice' in ctx.message) {
                const fileId = ctx.message.voice.file_id;
                await bot.telegram.sendVoice(faturamentoChatId, fileId, { caption: `👷‍♂️ *${senderName} (Loja):*\n${text}`, message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown' });
             } else if ('document' in ctx.message) {
                const fileId = ctx.message.document.file_id;
                await bot.telegram.sendDocument(faturamentoChatId, fileId, { caption: `👷‍♂️ *${senderName} (Loja):*\n${text}`, message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown' });
             }
         }
      }
    }
    return next();
  });

  // ==========================================
  // ENTREVISTA - RESPOSTAS DO USUÁRIO NO TÓPICO DO RECEBIMENTO
  // ==========================================
  bot.on('text', async (ctx, next) => {
    if (!ctx.chat || !ctx.message || !ctx.from || !ctx.message.message_thread_id) return next();
    const text = ctx.message.text;
    
    const { data: ticket } = await supabase.from('receiving_logs')
      .select('*')
      .eq('recebimento_thread_id', ctx.message.message_thread_id.toString())
      .in('status', ['draft_fornecedor', 'draft_valor', 'draft_problema'])
      .order('id', { ascending: false })
      .limit(1)
      .single();
      
    if (ticket) {
      if (ticket.status === 'draft_fornecedor') {
        await ctx.telegram.sendMessage(ctx.chat.id, '💰 Passo 2: Digite abaixo o **VALOR TOTAL** das notas:', { 
          parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id
        });
        await supabase.from('receiving_logs').update({ supplier: text, status: 'draft_valor' }).eq('id', ticket.id);
        return next();
      }

      if (ticket.status === 'draft_valor') {
          await supabase.from('receiving_logs').update({
            invoice_value: parseFloat(text.replace(',', '.').replace(/[^\d.-]/g, '')), status: 'pendente'
          }).eq('id', ticket.id);
          
          await ctx.telegram.sendMessage(ctx.chat.id, '✅ Tudo certo! A entrega foi enviada para o Faturamento.', { message_thread_id: ctx.message.message_thread_id });
          await forwardToFaturamento(bot, ticket.id);
          return next();
      }

      if (ticket.status === 'draft_problema') {
        await supabase.from('receiving_logs').update({ problem_description: text, status: 'pendente' }).eq('id', ticket.id);
        await ctx.telegram.sendMessage(ctx.chat.id, '🚨 Divergência completa! O ticket foi enviado para o faturamento.', { message_thread_id: ctx.message.message_thread_id });
        await forwardToFaturamento(bot, ticket.id);
        return next();
      }
    }
    return next();
  });

  // ==========================================
  // RECEPÇÃO DE VÍDEO BOLINHA (Recebimento Físico)
  // ==========================================
  bot.on('video_note', async (ctx, next) => {
    const chatId = ctx.chat.id.toString();
    const { data: group } = await supabase.from('groups_config').select('*').eq('chat_id', chatId).single();
    if (!group || group.sector !== 'recebimento') return next();

    const threadId = ctx.message.message_thread_id;
    if (!threadId) return next();

    // Encontra o ticket atrelado a este tópico
    const { data: ticket } = await supabase.from('receiving_logs')
       .select('*')
       .eq('chat_id', chatId)
       .eq('recebimento_thread_id', threadId.toString())
       .single();

    if (!ticket) return next();
    if (ticket.physical_receipt_at) return next();

    const recebedorName = ctx.from.first_name;
    await supabase.from('receiving_logs').update({ physical_receipt_at: new Date().toISOString() }).eq('id', ticket.id);

    await ctx.reply(`✅ **Recebimento físico confirmado por ${recebedorName}!** O vídeo bolinha foi registrado.`, { parse_mode: 'Markdown', reply_parameters: { message_id: ctx.message.message_id } });

    if (ticket.thread_id) {
       const { data: fatGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'faturamento');
       if (fatGroups && fatGroups.length > 0) {
           const faturamentoChatId = fatGroups[0].chat_id;
           try {
              const fileLink = await bot.telegram.getFileLink(ctx.message.video_note.file_id);
              const response = await fetch(fileLink.href);
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);

              await bot.telegram.sendVideo(faturamentoChatId, { source: buffer, filename: 'bolinha.mp4' }, {
                 message_thread_id: parseInt(ticket.thread_id),
                 caption: `✅ **Vídeo bolinha recebido de ${recebedorName}!** (Loja)\n*(Convertido para vídeo normal para funcionar no Telegram Web)*`,
                 parse_mode: 'Markdown'
              });
           } catch (e) {
              console.error('ERRO AO CONVERTER VIDEO BOLINHA:', e);
              await bot.telegram.copyMessage(faturamentoChatId, chatId, ctx.message.message_id, { message_thread_id: parseInt(ticket.thread_id) }).catch(()=>{});
              await bot.telegram.sendMessage(faturamentoChatId, `✅ **Vídeo bolinha recebido de ${recebedorName}!** (Loja)`, { message_thread_id: parseInt(ticket.thread_id), parse_mode: 'Markdown' }).catch(()=>{});
           }
       }
    }

    await checkReadyForAnalysis(bot, ticket.id);
  });

  // ==========================================
  // RECEPÇÃO DE FOTOS NO GENERAL (E CRIAÇÃO DO TÓPICO)
  // ==========================================
  const processingAlbums = new Set<string>();
  const albumMessageIds = new Map<string, string>();

  bot.on(['photo', 'voice', 'document'], async (ctx, next) => {
    console.log('--- FOTO RECEBIDA ---', JSON.stringify(ctx.message, null, 2));
    const chatId = ctx.chat.id.toString();
    const { data: group } = await supabase.from('groups_config').select('*').eq('chat_id', chatId).single();
    if (!group || group.sector !== 'recebimento') return next();
    if (ctx.message.message_thread_id) {
       // Verifica se a foto foi mandada dentro de um tópico que já é um ticket ativo
       const { data: existingThreadTicket } = await supabase.from('receiving_logs').select('id').eq('recebimento_thread_id', ctx.message.message_thread_id.toString()).maybeSingle();
       if (existingThreadTicket) return next(); // É um ticket, a ponte bidirecional vai pegar!
       // Se não for um ticket (ex: enviou no tópico geral "ENVIE AS NOTAS AQUI"), segue o fluxo de criação.
    }

    const msgId = ctx.message.message_id.toString();
    const mediaGroupId = (ctx.message as any).media_group_id;

    if (mediaGroupId) {
       if (processingAlbums.has(mediaGroupId)) {
          // Pacote já está sendo processado, só joga a foto no tópico criado
          const fetchAndProcess = async (retries = 3) => {
             const { data: existing } = await supabase.from('receiving_logs').select('*').eq('media_group_id', mediaGroupId).eq('chat_id', chatId).single();
             if (existing) {
                if (existing.recebimento_thread_id) {
                   const copyObj = await bot.telegram.copyMessage(chatId, chatId, parseInt(msgId), { message_thread_id: parseInt(existing.recebimento_thread_id) });
                   await bot.telegram.deleteMessage(chatId, parseInt(msgId)).catch(()=>{});
                   const currentIds = albumMessageIds.get(mediaGroupId) || existing.original_message_id;
                   const newIds = currentIds + ',' + copyObj.message_id;
                   albumMessageIds.set(mediaGroupId, newIds);
                   await supabase.from('receiving_logs').update({ original_message_id: newIds }).eq('id', existing.id);
                }
             } else if (retries > 0) {
                setTimeout(() => fetchAndProcess(retries - 1), 1000);
             }
          };
          fetchAndProcess();
          return next();
       } else {
          // PRIMEIRA FOTO DO ÁLBUM
          processingAlbums.add(mediaGroupId);
          
          const topicName = `📦 Ticket - Em preenchimento`;
          const topic = await bot.telegram.createForumTopic(chatId, topicName).catch((e)=>{
              console.error('ERRO CRIAR TOPICO ALBUM', e);
              return null;
          });
          const threadId = topic ? topic.message_thread_id.toString() : null;

          const { data: newTicket } = await supabase.from('receiving_logs').insert({
             store_name: group.store_name, requester_name: ctx.from.first_name, type: 'album', status: 'album_pending',
             chat_id: chatId, media_group_id: mediaGroupId, original_message_id: msgId, recebimento_thread_id: threadId
          }).select().single();
          
          if (threadId) {
             const copyObj = await bot.telegram.copyMessage(chatId, chatId, parseInt(msgId), { message_thread_id: parseInt(threadId) });
             albumMessageIds.set(mediaGroupId, copyObj.message_id.toString());
             await supabase.from('receiving_logs').update({ original_message_id: copyObj.message_id.toString() }).eq('id', newTicket.id);
             await bot.telegram.deleteMessage(chatId, parseInt(msgId)).catch(()=>{});
             
             await ctx.telegram.sendMessage(chatId, 'Como você classifica essa entrega (mesmo se tiver várias notas)?', {
               message_thread_id: parseInt(threadId),
               reply_markup: {
                  inline_keyboard: [
                     [{ text: '🟢 Compra Externa (Com Bono)', callback_data: `nota_ok_${newTicket.id}` }],
                     [{ text: '🔴 Compra Externa (Sem Bono)', callback_data: `nota_erro_${newTicket.id}` }],
                     [{ text: '🔄 Transfer. Interna (Com Bono)', callback_data: `transf_ok_${newTicket.id}` }],
                     [{ text: '🚨 Transfer. Interna (Sem Bono)', callback_data: `transf_erro_${newTicket.id}` }]
                  ]
               }
             });
          }

          setTimeout(() => {
             processingAlbums.delete(mediaGroupId);
             albumMessageIds.delete(mediaGroupId);
          }, 60000);
       }
    } else {
       // FOTO ÚNICA (SEM ÁLBUM)
       const topicName = `📦 Ticket - Em preenchimento`;
       const topic = await bot.telegram.createForumTopic(chatId, topicName).catch((e)=>{
           console.error('ERRO CRIAR TOPICO', e);
           return null;
       });
       console.log('TOPICO CRIADO:', topic);
       const threadId = topic ? topic.message_thread_id.toString() : null;

       const { data: newTicket } = await supabase.from('receiving_logs').insert({
          store_name: group.store_name, requester_name: ctx.from.first_name, type: 'album', status: 'album_pending',
          chat_id: chatId, original_message_id: msgId, recebimento_thread_id: threadId
       }).select().single();

       if (threadId) {
          const copyObj = await bot.telegram.copyMessage(chatId, chatId, parseInt(msgId), { message_thread_id: parseInt(threadId) });
          await supabase.from('receiving_logs').update({ original_message_id: copyObj.message_id.toString() }).eq('id', newTicket.id);
          await bot.telegram.deleteMessage(chatId, parseInt(msgId)).catch(()=>{});
          
          await ctx.telegram.sendMessage(chatId, 'Como você classifica essa entrega (mesmo se tiver várias notas)?', {
            message_thread_id: parseInt(threadId),
            reply_markup: {
               inline_keyboard: [
                  [{ text: '🟢 Compra Externa (Com Bono)', callback_data: `nota_ok_${newTicket.id}` }],
                  [{ text: '🔴 Compra Externa (Sem Bono)', callback_data: `nota_erro_${newTicket.id}` }],
                  [{ text: '🔄 Transfer. Interna (Com Bono)', callback_data: `transf_ok_${newTicket.id}` }],
                  [{ text: '🚨 Transfer. Interna (Sem Bono)', callback_data: `transf_erro_${newTicket.id}` }]
               ]
            }
          });
       }
    }
  });

  bot.action(/^nota_ok_(\d+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await supabase.from('receiving_logs').update({ type: 'sucesso', status: 'draft_fornecedor', operation_type: 'compra' }).eq('id', ticketId);
    await ctx.editMessageText(`✅ Compra Externa Com Bono (Iniciando apuração...)`, { parse_mode: 'Markdown' });
    await ctx.telegram.sendMessage(ctx.chat!.id, `📝 Passo 1: Digite abaixo o **NOME DO FORNECEDOR**:`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
  });

  bot.action(/^nota_erro_(\d+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await supabase.from('receiving_logs').update({ type: 'divergencia', status: 'draft_fornecedor', operation_type: 'compra' }).eq('id', ticketId);
    await ctx.editMessageText(`🚨 Compra Externa Sem Bono (Iniciando apuração...)`, { parse_mode: 'Markdown' });
    await ctx.telegram.sendMessage(ctx.chat!.id, `📝 Passo 1: Digite abaixo o **NOME DO FORNECEDOR**:`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
  });

  bot.action(/^transf_ok_(\d+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await supabase.from('receiving_logs').update({ type: 'sucesso', status: 'draft_fornecedor', operation_type: 'transferencia' }).eq('id', ticketId);
    await ctx.editMessageText(`🔄 Transferência Interna Com Bono (Iniciando apuração...)`, { parse_mode: 'Markdown' });
    await ctx.telegram.sendMessage(ctx.chat!.id, `📝 Passo 1: Digite abaixo a **LOJA DE ORIGEM**:`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
  });

  bot.action(/^transf_erro_(\d+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    await supabase.from('receiving_logs').update({ type: 'divergencia', status: 'draft_fornecedor', operation_type: 'transferencia' }).eq('id', ticketId);
    await ctx.editMessageText(`🚨 Transferência Interna Sem Bono (Iniciando apuração...)`, { parse_mode: 'Markdown' });
    
    // Notifica gerente!
    const { data: ticket } = await supabase.from('receiving_logs').select('chat_id').eq('id', ticketId).single();
    if (ticket && ticket.chat_id) {
       const { data: group } = await supabase.from('groups_config').select('manager_username').eq('chat_id', ticket.chat_id).single();
       if (group && group.manager_username) {
          await ctx.telegram.sendMessage(ctx.chat!.id, `🚨 **ATENÇÃO ${group.manager_username}**: Esta é uma Transferência Sem Bono e requer seu acompanhamento!`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
       }
    }
    
    await ctx.telegram.sendMessage(ctx.chat!.id, `📝 Passo 1: Digite abaixo a **LOJA DE ORIGEM**:`, { parse_mode: 'Markdown', message_thread_id: (ctx.callbackQuery.message as any)?.message_thread_id });
  });

  // ==========================================
  // RESOLUÇÃO PELA FATURISTA
  // ==========================================
  bot.action(/^assume_nf_(\d+)$/, async (ctx) => {
      const ticketId = ctx.match[1];
      const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
      if (!ticket || ticket.status === 'resolvido') return ctx.answerCbQuery('Ticket já encerrado ou não encontrado.');
  
      const resolverName = ctx.from.first_name;
      await supabase.from('receiving_logs').update({ assumed_by: resolverName }).eq('id', ticketId);
  
      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [[{ text: `✅ Assumido por ${resolverName}`, callback_data: `noop` }]]
        });
      } catch (e) {}
  
      ctx.answerCbQuery(`Você assumiu!`);
  
      if (ticket.chat_id && ticket.recebimento_thread_id) {
          await bot.telegram.sendMessage(ticket.chat_id, `👨‍💻 A faturista *${resolverName}* assumiu a apuração! Podem trocar mensagens agora.`, { 
             message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown' 
          }).catch(()=>{});
      }

      if (ticket.thread_id) {
         try {
           const { data: fatGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'faturamento');
           if (fatGroups && fatGroups.length > 0) {
             const faturamentoChatId = fatGroups[0].chat_id;
             if (ticket.type === 'sucesso') {
                const msg = await bot.telegram.sendMessage(faturamentoChatId, `📌 **TICKET ASSUMIDO POR ${resolverName}**\n\nEssa nota já entrou **COM BONO**. Se estiver tudo certo no sistema, basta clicar no botão abaixo para passar a bola para a Analista:`, {
                  message_thread_id: parseInt(ticket.thread_id),
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[{ text: `✅ Tudo Certo! (Passar p/ Analista)`, callback_data: `bono_sent_${ticketId}` }]]
                  }
                });
                await bot.telegram.pinChatMessage(faturamentoChatId, msg.message_id).catch(()=>{});
             } else {
                await supabase.from('receiving_logs').update({ status: 'aguardando_bono' }).eq('id', ticketId);
                const msg = await bot.telegram.sendMessage(faturamentoChatId, `📌 **TICKET ASSUMIDO POR ${resolverName}**\n\nEssa nota entrou **SEM BONO**.\n\n⏳ Digite o número do Bono que você gerou aqui no chat para liberar o botão de passar para a Analista...`, {
                  message_thread_id: parseInt(ticket.thread_id),
                  parse_mode: 'Markdown'
                });
                await bot.telegram.pinChatMessage(faturamentoChatId, msg.message_id).catch(()=>{});
             }
           }
         } catch(e) {
           console.error('Erro ao pinar', e);
         }
      }
  });

  bot.action(/^bono_sent_(\d+)$/, async (ctx) => {
      const ticketId = ctx.match[1];
      const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
      if (!ticket || ticket.status === 'resolvido') return ctx.answerCbQuery('Ticket já encerrado ou não encontrado.');
  
      const faturistaName = ctx.from.first_name;
      
      await supabase.from('receiving_logs').update({ bono_sent: true }).eq('id', ticketId);

      try {
        await ctx.editMessageReplyMarkup({
          inline_keyboard: [[{ text: `✅ Bono enviado por ${faturistaName}`, callback_data: `noop` }]]
        });
      } catch (e) {}
  
      ctx.answerCbQuery(`Bono marcado como enviado!`);
  
      if (ticket.chat_id && ticket.recebimento_thread_id) {
          await bot.telegram.sendMessage(ticket.chat_id, `✅ A faturista *${faturistaName}* gerou o bono!`, { 
             message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown' 
          }).catch(()=>{});
      }

      await checkReadyForAnalysis(bot, parseInt(ticketId));
  });

  bot.action(/^resolve_nf_(\d+)$/, async (ctx) => {
    // A trava de ID fixo (Zeneide) foi removida. O fechamento agora é liberado
    // e o nome de quem clicou ficará registrado no banco de dados e na mensagem final.

    const ticketId = ctx.match[1];
    const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
    if (!ticket || ticket.status === 'resolvido') return ctx.answerCbQuery('Já resolvido!');

    try {
      await ctx.editMessageText(`📌 **COMO FOI A APURAÇÃO DESTE TICKET?**\n\nEscolha uma das opções abaixo para o encerramento oficial:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `🔵 Processo em andamento`, callback_data: `close_andamento_${ticketId}` }],
            [{ text: `🟢 Aceite Total (Tudo conforme)`, callback_data: `close_ok_${ticketId}` }],
            [{ text: `🟡 Aceite Total (Com ressalvas)`, callback_data: `close_ressalva_${ticketId}` }],
            [{ text: `🔴 Devolução Total`, callback_data: `close_devtot_${ticketId}` }],
            [{ text: `🟠 Devolução Parcial (Com ressalvas)`, callback_data: `close_devparc_${ticketId}` }]
          ]
        }
      });
    } catch (e) {
      console.error('Erro editando para opcoes', e);
    }
  });

  bot.action(/^close_(ok|ressalva|devtot|devparc|andamento)_(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const ticketId = ctx.match[2];
    const resolverName = ctx.from.first_name;

    const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
    if (!ticket || ticket.status === 'resolvido') return ctx.answerCbQuery('Já resolvido!');

    if (action === 'andamento') {
      await ctx.editMessageText(`🔵 **PROCESSO EM ANDAMENTO**\n\nA apuração deste ticket foi sinalizada como "Em Andamento" por ${resolverName}.\n\n*(Se houver pendências, você pode digitá-las normalmente aqui no chat)*\n\nQuando tudo estiver resolvido, clique abaixo para encerrar definitivamente:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Concluir Apuração (Analista)`, callback_data: `resolve_nf_${ticketId}` }]
          ]
        }
      });
      return ctx.answerCbQuery('Status atualizado para em andamento!');
    }

    const statusMap = {
      'ok': 'Aceite Total (Tudo conforme)',
      'ressalva': 'Aceite Total (Com ressalvas)',
      'devtot': 'Devolução Total',
      'devparc': 'Devolução Parcial (Com ressalvas)'
    };
    const conclusionStatus = statusMap[action as keyof typeof statusMap];

    if (action === 'ok') {
      await supabase.from('receiving_logs').update({ 
        status: 'resolvido', 
        conclusion_status: conclusionStatus,
        resolved_by: resolverName, 
        resolved_at: new Date().toISOString() 
      }).eq('id', ticketId);

      await ctx.editMessageText(`✅ **${conclusionStatus}**\n\nTicket finalizado por ${resolverName}.`, { parse_mode: 'Markdown' });
      ctx.answerCbQuery('Ticket concluído!');

      // Fechar faturamento
      if (ticket.thread_id) {
         const { data: fatGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'faturamento');
         if (fatGroups && fatGroups.length > 0) {
            const op = (ticket.operation_type || 'COMPRA').toUpperCase();
            const closedName = `✅ Ticket #${ticketId} - ${ticket.supplier} [${op}]`;
            await bot.telegram.editForumTopic(fatGroups[0].chat_id, parseInt(ticket.thread_id), { name: closedName }).catch(()=>{});
            await bot.telegram.closeForumTopic(fatGroups[0].chat_id, parseInt(ticket.thread_id)).catch(()=>{});
         }
      }
      
      // Fechar recebimento
      if (ticket.chat_id && ticket.recebimento_thread_id) {
         const msg = `✅ *TICKET CONCLUÍDO*\nFinalizado por *${resolverName}*\n\n📌 **Status:** ${conclusionStatus}\n\nA conversa foi encerrada.`;
         
         const { data: grp } = await supabase.from('groups_config').select('manager_username').eq('chat_id', ticket.chat_id).single();
         let finalMsg = msg;
         if (ticket.operation_type === 'transferencia' && ticket.type === 'divergencia' && grp?.manager_username) {
            finalMsg = `${msg}\n\n🚨 **Ciente ${grp.manager_username}? Acompanhamento finalizado.**`;
         }
         await bot.telegram.sendMessage(ticket.chat_id, finalMsg, {
            message_thread_id: parseInt(ticket.recebimento_thread_id), parse_mode: 'Markdown'
         }).catch(()=>{});
         const op = (ticket.operation_type || 'COMPRA').toUpperCase();
         const closedName = `✅ Ticket #${ticketId} - ${ticket.supplier} [${op}]`;
         await bot.telegram.editForumTopic(ticket.chat_id, parseInt(ticket.recebimento_thread_id), { name: closedName }).catch(()=>{});
         await bot.telegram.closeForumTopic(ticket.chat_id, parseInt(ticket.recebimento_thread_id)).catch(()=>{});
      }
    } else {
      await supabase.from('receiving_logs').update({ 
        status: 'aguardando_justificativa', 
        conclusion_status: conclusionStatus,
        resolved_by: resolverName 
      }).eq('id', ticketId);

      await ctx.editMessageText(`📌 Selecionado: **${conclusionStatus}**\n\n✍️ **Por favor, digite abaixo a descrição/motivo da ressalva ou devolução:**\n_(O ticket será encerrado automaticamente assim que você enviar o texto)_`, { parse_mode: 'Markdown' });
      ctx.answerCbQuery('Aguardando texto...');
    }
  });


  // ==========================================
  // RELATÓRIO DIÁRIO (20:00)
  // ==========================================
  cron.schedule('0 20 * * *', async () => {
    try {
      const { data: dirGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'diretoria');
      if (!dirGroups || dirGroups.length === 0) return;

      const now = new Date();
      const todayStr = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      const { data: logs } = await supabase.from('receiving_logs').select('*').gte('created_at', `${todayStr}T00:00:00Z`).lte('created_at', `${todayStr}T23:59:59Z`);

      if (!logs || logs.length === 0) return;

      let total = logs.length;
      let pendentes = logs.filter(l => l.status === 'pendente');
      let resolvidos = logs.filter(l => l.status === 'resolvido').length;

      let report = `📊 *RELATÓRIO DE RECEBIMENTO E FATURAMENTO (HOJE)*\n\n`;
      report += `📦 *Total de Entregas Processadas:* ${total}\n✔️ *Apurações Concluídas:* ${resolvidos}\n⚠️ *Pendentes:* ${pendentes.length}\n\n`;

      if (pendentes.length > 0) {
        report += `*Pendentes:*\n`;
        pendentes.forEach(p => { report += `- ${p.store_name} | ${p.supplier} (R$ ${p.invoice_value})\n`; });
      }

      for (const group of dirGroups) { await bot.telegram.sendMessage(group.chat_id, report, { parse_mode: 'Markdown' }); }
    } catch (error) {}
  }, { timezone: "America/Sao_Paulo" });

}

async function forwardToFaturamento(bot: Telegraf, ticketId: number) {
  try {
    const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
    if (!ticket) return;

    const { data: fatGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'faturamento');
    if (!fatGroups || fatGroups.length === 0) return;
    const faturamentoChatId = fatGroups[0].chat_id;

    const op = (ticket.operation_type || 'COMPRA').toUpperCase();
    const isSemBono = ticket.type === 'divergencia';

    const topicName = `🔵 Ticket #${ticketId} - ${ticket.supplier} [${op}]`;
    const topic = await bot.telegram.createForumTopic(faturamentoChatId, topicName).catch(()=>null);
    if (!topic) return;
    
    const threadId = topic.message_thread_id;
    await supabase.from('receiving_logs').update({ thread_id: threadId.toString() }).eq('id', ticketId);

    // Renomear o tópico do Recebimento para combinar!
    if (ticket.chat_id && ticket.recebimento_thread_id) {
       await bot.telegram.editForumTopic(ticket.chat_id, parseInt(ticket.recebimento_thread_id), { name: topicName }).catch(()=>{});
    }

    const subtitle = isSemBono ? '(Sem Bono)' : '(Com Bono)';
    const summary = `🔴 *NOVA APURAÇÃO ${subtitle} - #${ticketId} [${op}]*\n_Atenção Faturistas_\n\n🏬 *Loja:* ${ticket.store_name}\n👤 *Recebedor:* ${ticket.requester_name}\n🏷 *Fornecedor:* ${ticket.supplier}\n💰 *Valor:* R$ ${ticket.invoice_value}\n`;

    await bot.telegram.sendMessage(faturamentoChatId, summary, { message_thread_id: threadId, parse_mode: 'Markdown' });

    if (ticket.chat_id && ticket.original_message_id) {
      const photos = ticket.original_message_id.split(',');
      for (const pId of photos) {
        if (pId.trim() === '') continue;
        await bot.telegram.copyMessage(faturamentoChatId, ticket.chat_id, parseInt(pId), { message_thread_id: threadId }).catch(()=>{});
      }
    }

    const inline_keyboard = [[{ text: '✋ Assumir Apuração', callback_data: `assume_nf_${ticketId}` }]];

    await bot.telegram.sendMessage(faturamentoChatId, `👆 Escolha uma ação:`, {
      message_thread_id: threadId,
      reply_markup: { inline_keyboard }
    });

    await checkReadyForAnalysis(bot, ticketId);
  } catch (e) {
    console.error('Erro forwarding', e);
  }
}

async function checkReadyForAnalysis(bot: Telegraf, ticketId: number) {
    const { data: ticket } = await supabase.from('receiving_logs').select('*').eq('id', ticketId).single();
    if (!ticket || ticket.analyst_notified || !ticket.thread_id) return;

    const isBonoReady = ticket.bono_sent;
    const isVideoReady = !!ticket.physical_receipt_at;

    if (isBonoReady && isVideoReady) {
        await supabase.from('receiving_logs').update({ analyst_notified: true }).eq('id', ticketId);
        
        const { data: fatGroups } = await supabase.from('groups_config').select('chat_id').eq('sector', 'faturamento');
        if (fatGroups && fatGroups.length > 0) {
             const faturamentoChatId = fatGroups[0].chat_id;
             const msg = await bot.telegram.sendMessage(faturamentoChatId, `✅ **TUDO PRONTO!**\n\n- Bono Garantido\n- Vídeo do Recebimento Físico OK\n\nAnalista de Faturamento, você já pode iniciar e concluir a apuração final deste ticket:`, {
               message_thread_id: parseInt(ticket.thread_id),
               parse_mode: 'Markdown',
               reply_markup: {
                 inline_keyboard: [[{ text: `✅ Concluir Apuração (Analista)`, callback_data: `resolve_nf_${ticketId}` }]]
               }
             });
             await bot.telegram.pinChatMessage(faturamentoChatId, msg.message_id).catch(()=>{});
        }
    }
}
