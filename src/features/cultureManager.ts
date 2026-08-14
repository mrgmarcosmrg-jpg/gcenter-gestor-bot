import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';
import 'dotenv/config';

export function setupCultureManager(bot: Telegraf) {
   // 1. Ouvidoria Anônima (Caixinha de Sugestões)
   bot.command('sugestao', async (ctx) => {
      if (ctx.chat.type !== 'private') {
         return ctx.reply('⚠️ Por favor, mande suas sugestões apenas no meu privado para garantir o anonimato!');
      }
      
      const text = ctx.message.text.replace(/^\/sugestao\s*/i, '').trim();
      if (!text) {
         return ctx.reply('⚠️ Como usar: /sugestao Sua ideia ou reclamação aqui.\nExemplo: /sugestao Podíamos ter um café da manhã na sexta-feira.');
      }
      
      // Salva no banco de dados para histórico
      await supabase.from('suggestions').insert({ content: text });
      
      // Manda para os Diretores (Opcional, mas muito bom para eles verem na hora)
      const { data: diretores } = await supabase.from('user_roles').select('*').eq('role', 'diretor_operacional').eq('status', 'approved');
      if (diretores) {
         const msg = `📢 **Nova Sugestão Anônima na Ouvidoria!**\n\n_"${text}"_`;
         for (const dir of diretores) {
            await bot.telegram.sendMessage(dir.telegram_id, msg, { parse_mode: 'Markdown' }).catch(()=>{});
         }
      }
      
      await ctx.reply('✅ Sua mensagem foi enviada anonimamente para a caixa de sugestões da Diretoria! Muito obrigado por contribuir.');
   });

   // 2. Megafone Oficial (Aviso da Diretoria)
   bot.command('aviso_geral', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const telegramId = ctx.chat.id.toString();
      
      // Verifica se é um diretor aprovado
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', telegramId).eq('status', 'approved').like('role', 'diretor_%').single();
      
      if (!user) {
         return ctx.reply('⛔ Apenas Diretores cadastrados podem disparar mensagens no Megafone Oficial da rede.');
      }
      
      const text = ctx.message.text.replace(/^\/aviso_geral\s*/i, '').trim();
      if (!text) {
         return ctx.reply('⚠️ Como usar: /aviso_geral O texto do seu aviso aqui.');
      }
      
      const generalGroupId = process.env.GENERAL_GROUP_ID;
      if (!generalGroupId) {
         return ctx.reply('⛔ O ID do Grupo Geral ainda não foi configurado no sistema. Peça ao TI para colocar o GENERAL_GROUP_ID no arquivo .env.');
      }
      
      try {
         const msg = `🚨 **COMUNICADO OFICIAL DA DIRETORIA** 🚨\n\n${text}\n\n_Ass: ${user.name}_`;
         const sentMessage = await bot.telegram.sendMessage(generalGroupId, msg, { parse_mode: 'Markdown' });
         
         // Pin a mensagem (fixar)
         await bot.telegram.pinChatMessage(generalGroupId, sentMessage.message_id, { disable_notification: false });
         
         await ctx.reply('✅ Megafone disparado com sucesso! A mensagem foi postada e fixada no Grupo Geral.');
      } catch (err: any) {
         await ctx.reply(`❌ Erro ao enviar o aviso: ${err.message}`);
      }
   });

   // 3. Sistema de Estrelas (Gamificação / Reconhecimento)
   bot.command('reconhecer', async (ctx) => {
      // Pode ser usado tanto no privado quanto no grupo geral
      const telegramId = ctx.chat.id.toString();
      
      // Verifica se a pessoa que está enviando tem autoridade (opcional: restringir para gerentes/diretores)
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', telegramId).eq('status', 'approved');
      if (!user || user.length === 0) {
         return ctx.reply('⛔ Apenas Gestores cadastrados podem enviar reconhecimento.');
      }

      const match = ctx.message.text.match(/^\/reconhecer\s+(@\w+)\s+(.+)/i);
      if (!match) {
         return ctx.reply('⚠️ Como usar: /reconhecer @usuario Motivo do reconhecimento.\nExemplo: /reconhecer @joaocarlos Atendimento excelente hoje!');
      }

      const targetUsername = match[1];
      const motivo = match[2];

      const { data: employee } = await supabase.from('employees').select('*').ilike('telegram_username', targetUsername).single();
      
      if (!employee) {
         return ctx.reply(`❌ O usuário ${targetUsername} não foi encontrado na tabela de funcionários (employees).`);
      }

      const newStars = (employee.stars || 0) + 1;
      await supabase.from('employees').update({ stars: newStars }).eq('id', employee.id);

      const generalGroupId = process.env.GENERAL_GROUP_ID;
      if (generalGroupId) {
         const msg = `🌟 **RECONHECIMENTO!** 🌟\n\nParabéns ${targetUsername}! Você acaba de ganhar **+1 Estrela** pelo seguinte motivo:\n\n_"${motivo}"_\n\n🏆 Você agora tem **${newStars} Estrela(s)**! Continue assim!`;
         await bot.telegram.sendMessage(generalGroupId, msg, { parse_mode: 'Markdown' }).catch(()=>{});
         if (ctx.chat.type === 'private') {
            await ctx.reply('✅ Reconhecimento enviado para o Grupo Geral!');
         }
      } else {
         await ctx.reply(`✅ Reconhecimento salvo! ${targetUsername} agora tem ${newStars} estrela(s).`);
      }
   });

   // Comando Utilitário para descobrir o ID do grupo (O bot precisa estar no grupo)
   bot.command('pegar_id', async (ctx) => {
      if (ctx.chat.type === 'private') {
         return ctx.reply(`Este é um chat privado. O seu ID é: ${ctx.chat.id}\nPara pegar o ID de um grupo, adicione-me nele e digite /pegar_id lá.`);
      }
      return ctx.reply(`O ID numérico deste grupo é: \`${ctx.chat.id}\`\nCopie esse número e coloque na variável GENERAL_GROUP_ID do .env!`, { parse_mode: 'Markdown' });
   });

   // 4. CRON JOB: Aniversários e Tempo de Empresa (Todo dia às 08:30)
   cron.schedule('30 8 * * *', async () => {
      const generalGroupId = process.env.GENERAL_GROUP_ID;
      if (!generalGroupId) return;

      const today = new Date();
      const currentMonth = today.getMonth() + 1;
      const currentDay = today.getDate();
      const currentYear = today.getFullYear();

      const { data: employees } = await supabase.from('employees').select('*');
      if (!employees) return;

      for (const emp of employees) {
         // Verifica Aniversário de Vida
         if (emp.birth_date) {
            const bDate = new Date(emp.birth_date);
            if (bDate.getUTCMonth() + 1 === currentMonth && bDate.getUTCDate() === currentDay) {
               const name = emp.telegram_username ? emp.telegram_username : emp.name;
               const msg = `🎉🎂 **HOJE É DIA DE FESTA!** 🎂🎉\n\nHoje é o aniversário do(a) **${name}** da loja **${emp.store_name || 'GCenter'}**!\n\nVamos todos desejar muitas felicidades, saúde e sucesso! Deixe seu parabéns aqui! 🎈🥳`;
               await bot.telegram.sendMessage(generalGroupId, msg, { parse_mode: 'Markdown' }).catch(()=>{});
            }
         }

         // Verifica Tempo de Casa (Admissão)
         if (emp.hire_date) {
            const hDate = new Date(emp.hire_date);
            if (hDate.getUTCMonth() + 1 === currentMonth && hDate.getUTCDate() === currentDay) {
               const years = currentYear - hDate.getUTCFullYear();
               if (years > 0) {
                  const name = emp.telegram_username ? emp.telegram_username : emp.name;
                  const msg = `💼🌟 **MOMENTO DE CELEBRAÇÃO!** 🌟💼\n\nHoje o(a) **${name}** completa **${years} ano(s)** de dedicação ao **GCenter**!\n\nMuito obrigado pelo seu trabalho e esforço durante todo esse tempo. Você faz a diferença! 👏🚀`;
                  await bot.telegram.sendMessage(generalGroupId, msg, { parse_mode: 'Markdown' }).catch(()=>{});
               }
            }
         }
      }
   }, { timezone: "America/Sao_Paulo" });
}
