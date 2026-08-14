import { Telegraf, Markup } from 'telegraf';
import { supabase } from '../database/db';
import 'dotenv/config';

interface OnboardingState {
   step: 'nome' | 'aniversario' | 'endereco' | 'loja' | 'cargo' | 'aguardando';
   generalGroupId: number;
   nome?: string;
   aniversario?: string;
   endereco?: string;
   loja?: string;
   cargo?: string;
}

interface DirectorEditState {
   action: 'editing_role';
   targetUserId: number;
   targetName: string;
   generalGroupId: number;
}

const sessions = new Map<number, OnboardingState>();
const directorSessions = new Map<number, DirectorEditState>();

export function setupGatekeeper(bot: Telegraf) {
   // 1. Intercepta pedidos para entrar no grupo
   bot.on('chat_join_request', async (ctx) => {
      const userId = ctx.from.id;
      const groupId = ctx.chatJoinRequest.chat.id;

      sessions.set(userId, { step: 'nome', generalGroupId: groupId });

      const msg = `👋 **Bem-vindo ao processo de admissão do Grupo GCenter!**\n\nPara que eu possa enviar o seu pedido de entrada para a Diretoria aprovar, preciso fazer um rápido cadastro.\n\nPor favor, digite o seu **Nome Completo**:`;
      
      try {
         await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
      } catch (err) {
         console.error('Erro ao chamar no privado:', err);
      }
   });

   // 2. Captura as respostas de texto no privado
   bot.on('text', async (ctx, next) => {
      if (ctx.chat.type !== 'private') return next();
      
      const userId = ctx.from.id;
      
      // Verifica se é um DIRETOR editando um cargo
      const dirSession = directorSessions.get(userId);
      if (dirSession && dirSession.action === 'editing_role') {
         if (ctx.message.text.startsWith('/')) return next();
         
         const novoCargo = ctx.message.text;
         const targetId = dirSession.targetUserId;
         const groupId = dirSession.generalGroupId;
         
         // Atualiza o banco de dados
         await supabase.from('employees').update({ role_title: novoCargo }).eq('telegram_username', String(targetId)); // Usando telegram_username provisoriamente para guardar ID
         
         // Aprova a entrada
         try {
            await bot.telegram.approveChatJoinRequest(groupId, targetId);
            await ctx.reply(`✅ Cargo alterado para *${novoCargo}* e entrada do(a) **${dirSession.targetName}** aprovada com sucesso!`, { parse_mode: 'Markdown' });
            
            // Avisa o funcionário
            await bot.telegram.sendMessage(targetId, `✅ **Cadastro Aprovado!**\nA Diretoria aprovou sua entrada e corrigiu seu cargo oficial para: **${novoCargo}**.\n\nVocê já pode acessar o Grupo GCenter!`, { parse_mode: 'Markdown' });
         } catch (err: any) {
            await ctx.reply(`❌ Erro ao aprovar a entrada: ${err.message}`);
         }
         
         directorSessions.delete(userId);
         return;
      }

      // Verifica se é um FUNCIONÁRIO na entrevista
      const session = sessions.get(userId);
      if (!session) return next();

      if (ctx.message.text.startsWith('/')) return next();

      if (session.step === 'nome') {
         session.nome = ctx.message.text;
         session.step = 'aniversario';
         await ctx.reply('📅 Obrigado! Agora, digite a sua **Data de Nascimento** (Ex: 25/12/1990):', { parse_mode: 'Markdown' });
         return;
      }

      if (session.step === 'aniversario') {
         const text = ctx.message.text;
         if (!text.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
            await ctx.reply('⚠️ Formato inválido. Por favor, digite no formato DD/MM/AAAA (Ex: 25/12/1990):');
            return;
         }
         const [day, month, year] = text.split('/');
         session.aniversario = `${year}-${month}-${day}`;
         session.step = 'endereco';
         await ctx.reply('🏠 Certo! Agora digite o seu **Endereço Completo** (Rua, Número, Bairro, Cidade):', { parse_mode: 'Markdown' });
         return;
      }

      if (session.step === 'endereco') {
         session.endereco = ctx.message.text;
         session.step = 'loja';

         const { data: stores } = await supabase.from('groups_config').select('store_name');
         const buttons = [];
         
         if (stores) {
            for (const s of stores) {
               if (s.store_name) {
                  buttons.push([Markup.button.callback(s.store_name, `store_${s.store_name}`)]);
               }
            }
         }
         // Fallback se o banco não tiver lojas formatadas ainda
         if (buttons.length === 0) {
            buttons.push([Markup.button.callback('GCenter 01', 'store_GCenter 01')]);
            buttons.push([Markup.button.callback('GCenter 15', 'store_GCenter 15')]);
         }
         buttons.push([Markup.button.callback('Escritório Central / Outros', 'store_Central')]);

         await ctx.reply('🏬 Quase lá! Selecione abaixo em qual loja você trabalha:', Markup.inlineKeyboard(buttons));
         return;
      }

      if (session.step === 'cargo') {
         session.cargo = ctx.message.text;
         session.step = 'aguardando';

         // Salvar no Banco
         // Usamos o campo telegram_username para guardar o ID real do usuário também de forma temporária se precisarmos (ideal seria uma coluna telegram_id)
         await supabase.from('employees').insert({
            name: session.nome,
            telegram_username: String(userId), 
            birth_date: session.aniversario,
            address: session.endereco,
            store_name: session.loja,
            role_title: session.cargo,
            hire_date: new Date().toISOString().split('T')[0]
         });

         await ctx.reply('⏳ **Tudo pronto!**\nSeus dados foram enviados para a Diretoria.\nAssim que eles revisarem o seu cadastro, você receberá a aprovação para entrar no Grupo GCenter. Aguarde!', { parse_mode: 'Markdown' });

         // Avisar os diretores
         const { data: diretores } = await supabase.from('user_roles').select('*').eq('role', 'diretor_operacional').eq('status', 'approved');
         
         if (diretores && diretores.length > 0) {
            const msgToDirector = `🚨 **NOVO PEDIDO DE ENTRADA (GRUPO GERAL)**\n\n` +
               `**Nome:** ${session.nome}\n` +
               `**Aniversário:** ${session.aniversario}\n` +
               `**Endereço:** ${session.endereco}\n` +
               `**Loja:** ${session.loja}\n` +
               `**Cargo Informado:** ${session.cargo}\n\n` +
               `O que deseja fazer?`;

            const keyboard = Markup.inlineKeyboard([
               [Markup.button.callback('✅ Aprovar Como Está', `gate_approve_${userId}_${session.generalGroupId}`)],
               [Markup.button.callback('✏️ Corrigir Cargo e Aprovar', `gate_edit_${userId}_${session.generalGroupId}`)],
               [Markup.button.callback('❌ Recusar e Bloquear', `gate_reject_${userId}_${session.generalGroupId}`)]
            ]);

            for (const dir of diretores) {
               await bot.telegram.sendMessage(dir.telegram_id, msgToDirector, { parse_mode: 'Markdown', ...keyboard }).catch(()=>{});
            }
         }

         sessions.delete(userId);
         return;
      }

      return next();
   });

   // 3. Captura o clique da Loja na Entrevista
   bot.action(/^store_(.+)$/, async (ctx) => {
      const userId = ctx.from.id;
      const session = sessions.get(userId);
      
      if (!session || session.step !== 'loja') {
         await ctx.answerCbQuery('Sessão expirada. Tente entrar novamente pelo link.');
         return;
      }

      session.loja = ctx.match[1];
      session.step = 'cargo';
      
      await ctx.editMessageText(`Loja selecionada: **${session.loja}**`, { parse_mode: 'Markdown' });
      await ctx.reply('💼 Para finalizar, digite qual é o **seu Cargo ou Função** na empresa (Ex: Repositor, Caixa, Gerente):');
   });

   // 4. Ações da Diretoria
   bot.action(/^gate_approve_(\d+)_(\d+)$/, async (ctx) => {
      const targetUserId = parseInt(ctx.match[1]);
      const groupId = parseInt(ctx.match[2]);

      try {
         await bot.telegram.approveChatJoinRequest(groupId, targetUserId);
         await ctx.editMessageText('✅ **Aprovado!** A entrada do funcionário foi liberada sem alterações no cargo.', { parse_mode: 'Markdown' });
         
         await bot.telegram.sendMessage(targetUserId, `✅ **Cadastro Aprovado!**\nA Diretoria liberou sua entrada.\nVocê já pode acessar o Grupo GCenter!`, { parse_mode: 'Markdown' }).catch(()=>{});
      } catch (err: any) {
         await ctx.editMessageText(`❌ Houve um erro ao aprovar a entrada: ${err.message}`);
      }
   });

   bot.action(/^gate_reject_(\d+)_(\d+)$/, async (ctx) => {
      const targetUserId = parseInt(ctx.match[1]);
      const groupId = parseInt(ctx.match[2]);

      try {
         await bot.telegram.declineChatJoinRequest(groupId, targetUserId);
         await ctx.editMessageText('❌ **Recusado.** A entrada foi bloqueada.', { parse_mode: 'Markdown' });
         
         await bot.telegram.sendMessage(targetUserId, `❌ **Cadastro Recusado!**\nA Diretoria não autorizou sua entrada no grupo no momento.`, { parse_mode: 'Markdown' }).catch(()=>{});
      } catch (err: any) {
         await ctx.editMessageText(`❌ Houve um erro ao recusar a entrada: ${err.message}`);
      }
   });

   bot.action(/^gate_edit_(\d+)_(\d+)$/, async (ctx) => {
      const targetUserId = parseInt(ctx.match[1]);
      const groupId = parseInt(ctx.match[2]);
      const directorId = ctx.from.id;

      directorSessions.set(directorId, {
         action: 'editing_role',
         targetUserId,
         generalGroupId: groupId,
         targetName: 'Funcionário'
      });

      await ctx.editMessageText('✏️ **Modo de Correção Ativado.**', { parse_mode: 'Markdown' });
      await ctx.reply('Digite o **Cargo Correto** que devo registrar para este funcionário:');
   });

   // Comando de Aviso Direcionado (Para Diretores) - OPÇÃO A (Marcação no grupo)
   bot.command('aviso_loja', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      
      const telegramId = ctx.chat.id.toString();
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', telegramId).eq('status', 'approved').like('role', 'diretor_%').single();
      
      if (!user) {
         return ctx.reply('⛔ Apenas Diretores cadastrados podem enviar Avisos Direcionados.');
      }

      const match = ctx.message.text.match(/^\/aviso_loja\s+"([^"]+)"\s+(.+)/s) || ctx.message.text.match(/^\/aviso_loja\s+([\w\s]+?)\s*-\s*(.+)/s);
      
      if (!match) {
         return ctx.reply('⚠️ Formato incorreto.\nOpção 1: `/aviso_loja "GCenter 15" O caminhão chegou`\nOpção 2: `/aviso_loja GCenter 15 - O caminhão chegou`', { parse_mode: 'Markdown' });
      }

      const storeName = match[1].trim();
      const text = match[2].trim();

      const generalGroupId = process.env.GENERAL_GROUP_ID;
      if (!generalGroupId) {
         return ctx.reply('⛔ O ID do Grupo Geral ainda não foi configurado (.env).');
      }

      const msg = `📍 **AVISO: EQUIPE ${storeName.toUpperCase()}**\n\n${text}\n\n_Ass: ${user.name}_`;

      try {
         await bot.telegram.sendMessage(generalGroupId, msg, { parse_mode: 'Markdown' });
         await ctx.reply('✅ Aviso direcionado enviado e postado no Grupo Geral com sucesso!');
      } catch (err: any) {
         await ctx.reply(`❌ Erro ao enviar aviso: ${err.message}`);
      }
   });
}
