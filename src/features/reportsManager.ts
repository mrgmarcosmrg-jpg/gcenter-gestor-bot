import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';

// --- Utilitários de Tempo ---
function calculateSLA(start: string, end: string): number {
   const d1 = new Date(start).getTime();
   const d2 = new Date(end).getTime();
   return Math.max(0, d2 - d1);
}

function formatDuration(ms: number): string {
   const hours = Math.floor(ms / (1000 * 60 * 60));
   const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
   if (hours > 0) return `${hours}h ${minutes}m`;
   return `${minutes}m`;
}

function getEfficiency(total: number, errors: number): number {
   if (total === 0) return 100;
   return Math.round(((total - errors) / total) * 100);
}

function formatTicketLink(ticket: any): string {
   if (ticket.chat_id && ticket.recebimento_thread_id) {
      const chatStr = ticket.chat_id.toString().replace('-100', '');
      return `[#${ticket.id}](https://t.me/c/${chatStr}/${ticket.recebimento_thread_id})`;
   }
   return `#${ticket.id}`;
}

export function setupReportsManager(bot: Telegraf) {
   // Cadastro de Gerente e Subgerente por loja específica
   const lojas = ['05', '07', '21', '22', '23'];
   const comandosGerenteLoja = lojas.map(l => `sou_gerente_loja_${l}`);
   const comandosSubgerenteLoja = lojas.map(l => `sou_subgerente_loja_${l}`);

   bot.command([...comandosGerenteLoja, ...comandosSubgerenteLoja, 'sou_gerente', 'sou_subgerente'], async (ctx) => {
      if (ctx.chat.type !== 'private') return ctx.reply('⚠️ Por favor, use este comando no meu privado!');
      const cmd = ctx.message.text.split(' ')[0].replace('/', '').replace('@GCenter_Supermercado_bot', '');
      const isSub = cmd.startsWith('sou_subgerente');
      const roleBase = isSub ? 'subgerente' : 'gerente';

      // Verifica se é um comando com loja embutida (ex: sou_gerente_loja_21)
      const lojaMatch = cmd.match(/loja_(\d+)/);
      if (lojaMatch) {
         const lojaNum = lojaMatch[1];
         const { data: group } = await supabase.from('groups_config').select('*').ilike('store_name', `%${lojaNum}%`).single();
         const storeLabel = group ? group.store_name : `Loja ${lojaNum}`;
         await registerPendingRole(bot, ctx, `${roleBase}_loja_${lojaNum}`, storeLabel);
         return;
      }

      // Fallback: comando genérico com nome da loja por parâmetro
      const match = ctx.message.text.match(/^\/sou_(?:sub)?gerente\s+(.+)/i);
      if (!match) return ctx.reply(`⚠️ Use um comando específico como /sou_gerente_loja_21\nOu: /sou_${roleBase} Nome da Loja`);
      const storeName = match[1].trim();
      const { data: group } = await supabase.from('groups_config').select('*').ilike('store_name', storeName).single();
      if (!group) return ctx.reply(`❌ Não encontrei nenhuma loja configurada com o nome "${storeName}".`);
      await registerPendingRole(bot, ctx, roleBase, group.store_name);
   });

   // Cadastro de Supervisor
   bot.command('sou_supervisor', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      await registerPendingRole(bot, ctx, 'supervisor');
   });

   // Cadastro de Diretores
   bot.command(['sou_diretor', 'sou_diretor_operacional', 'sou_diretor_administrativo', 'sou_diretor_financeiro', 'sou_diretor_comercial'], async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const match = ctx.message.text.match(/^\/sou_diretor[_\s]+(operacional|administrativo|financeiro|comercial)/i);
      if (!match) return ctx.reply('⚠️ Como usar: /sou_diretor [operacional | administrativo | financeiro | comercial]');
      const setor = match[1].toLowerCase();
      await registerPendingRole(bot, ctx, `diretor_${setor}`);
   });

   // Cadastro de Analistas, Contador e demais cargos especializados
   bot.command([
      'sou_analista_contas_a_pagar',
      'sou_analista_contas_a_receber',
      'sou_analista_de_faturamento',
      'sou_contador',
      'sou_nutricionista_gcenter',
      'sou_gerente_producao_15',
      'sou_gerente_producao_19',
      'sou_comprador_supervisor',
   ], async (ctx) => {
      if (ctx.chat.type !== 'private') return ctx.reply('⚠️ Por favor, use este comando no meu privado!');
      const cmd = ctx.message.text.split(' ')[0].replace('/', '').replace('@GCenter_Supermercado_bot', '');
      const roleMap: Record<string, string> = {
         'sou_analista_contas_a_pagar':   'analista_contas_a_pagar',
         'sou_analista_contas_a_receber': 'analista_contas_a_receber',
         'sou_analista_de_faturamento':   'analista_de_faturamento',
         'sou_contador':                  'contador',
         'sou_nutricionista_gcenter':     'nutricionista_gcenter',
         'sou_gerente_producao_15':       'gerente_producao_loja_15',
         'sou_gerente_producao_19':       'gerente_producao_loja_19',
         'sou_comprador_supervisor':      'comprador_supervisor',
      };
      const role = roleMap[cmd];
      if (!role) return;
      await registerPendingRole(bot, ctx, role);

   });

   // Comando para Sair (Unsubscribe)
   bot.command(['sair_relatorios', 'sair'], async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', ctx.chat.id.toString()).single();
      if (!user) return ctx.reply('⚠️ Você já não está cadastrado em nenhum cargo para receber relatórios.');

      await supabase.from('user_roles').delete().eq('telegram_id', ctx.chat.id.toString());
      return ctx.reply('📴 Tudo bem! Seu cargo foi removido e você não receberá mais os relatórios automáticos no seu privado.');
   });

   // Handlers para os botões de aprovação
   bot.action(/^approve_role_(.+)$/, async (ctx) => {
      const targetId = ctx.match[1];
      await supabase.from('user_roles').update({ status: 'approved' }).eq('telegram_id', targetId);
      
      await ctx.editMessageText(`✅ **Acesso Aprovado!**\nO usuário teve seu acesso liberado com sucesso.`, { parse_mode: 'Markdown' });
      await bot.telegram.sendMessage(targetId, '🎉 **Acesso Aprovado!**\nA Diretoria aprovou sua solicitação. Você passará a receber os relatórios confidenciais.', { parse_mode: 'Markdown' }).catch(()=>{});
   });

   bot.action(/^reject_role_(.+)$/, async (ctx) => {
      const targetId = ctx.match[1];
      await supabase.from('user_roles').delete().eq('telegram_id', targetId);
      
      await ctx.editMessageText(`❌ **Acesso Recusado.**\nO pedido do usuário foi negado e deletado do sistema.`, { parse_mode: 'Markdown' });
      await bot.telegram.sendMessage(targetId, '❌ **Acesso Negado.**\nSua solicitação de acesso aos relatórios foi recusada pela Diretoria.', { parse_mode: 'Markdown' }).catch(()=>{});
   });

   // Comando de teste (Dispara relatórios para a própria pessoa com base no cargo dela)
   bot.command('testar_relatorios', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', ctx.chat.id.toString()).single();
      if (!user) return ctx.reply('⚠️ Você não tem nenhum cargo registrado. Use os comandos de cadastro primeiro.');
      if (user.status !== 'approved') return ctx.reply('⏳ Seu cadastro ainda está aguardando aprovação da Diretoria Operacional.');
      
      await ctx.reply('⏳ Gerando e enviando relatórios de teste...');
      
      if (user.role === 'gerente' || user.role === 'subgerente') {
         await runMorningReport(bot, user);
         await runEveningReport(bot, user);
         await runWeeklyReport(bot, user);
      } else {
         await runNetworkEveningReport(bot, user);
      }
      await ctx.reply('✅ Disparos concluídos!');
   });

   // Comando para testar o relatório de ontem manualmente
   bot.command('fechamento_ontem', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const { data: user } = await supabase.from('user_roles').select('*').eq('telegram_id', ctx.chat.id.toString()).single();
      if (!user) return ctx.reply('⚠️ Você não tem nenhum cargo registrado.');
      if (user.status !== 'approved') return ctx.reply('⏳ Seu cadastro ainda está aguardando aprovação.');
      
      await ctx.reply('⏳ Gerando boletim de Oculto (Ontem)...');
      
      const ontem = new Date();
      ontem.setDate(ontem.getDate() - 1);
      await runNetworkEveningReport(bot, user, ontem);
      await ctx.reply('✅ Boletim de ontem concluído!');
   });

   // CRON JOBS (Filtrando apenas approved)
   cron.schedule('0 8 * * 1-6', async () => {
      const { data: users } = await supabase.from('user_roles').select('*').eq('status', 'approved').in('role', ['gerente', 'subgerente']);
      if (users) for (const user of users) await runMorningReport(bot, user);
   }, { timezone: "America/Sao_Paulo" });

   // Relatório às 22h diário
   cron.schedule('0 22 * * *', async () => {
      const { data: usersStore } = await supabase.from('user_roles').select('*').eq('status', 'approved').in('role', ['gerente', 'subgerente']);
      if (usersStore) for (const user of usersStore) await runEveningReport(bot, user);
      
      const { data: usersNetwork } = await supabase.from('user_roles').select('*').eq('status', 'approved').in('role', ['supervisor', 'diretor_operacional', 'diretor_administrativo', 'diretor_financeiro', 'diretor_comercial', 'analista_de_faturamento']);
      if (usersNetwork) for (const user of usersNetwork) await runNetworkEveningReport(bot, user);
   }, { timezone: "America/Sao_Paulo" });

   cron.schedule('0 10 * * 6', async () => { // Sabado as 10h para o placar semanal
      const { data: usersStore } = await supabase.from('user_roles').select('*').eq('status', 'approved').in('role', ['gerente', 'subgerente']);
      if (usersStore) for (const user of usersStore) await runWeeklyReport(bot, user);
   }, { timezone: "America/Sao_Paulo" });
}

async function registerPendingRole(bot: Telegraf, ctx: any, role: string, storeName: string | null = null) {
   const telegramId = ctx.chat.id.toString();
   const name = ctx.from.first_name;

   const autoApprove = (role === 'diretor_operacional');

   await supabase.from('user_roles').delete().eq('telegram_id', telegramId);
   
   await supabase.from('user_roles').insert({
      telegram_id: telegramId,
      name: name,
      role: role,
      store_name: storeName,
      status: autoApprove ? 'approved' : 'pending'
   });

   if (autoApprove) {
      return ctx.reply(`✅ Olá ${name}! Você foi registrado como **DIRETOR OPERACIONAL**.\nSendo o administrador mestre, seu acesso foi auto-aprovado.`, { parse_mode: 'Markdown' });
   }

   await ctx.reply(`⏳ Seu pedido para atuar como **${role.toUpperCase()}** foi enviado para a Diretoria Operacional.\n\nVocê começará a receber os relatórios assim que o acesso for aprovado!`, { parse_mode: 'Markdown' });

   const { data: diretores } = await supabase.from('user_roles').select('*').eq('role', 'diretor_operacional').eq('status', 'approved');
   
   if (diretores && diretores.length > 0) {
      const location = storeName ? `\n📍 *Loja:* ${storeName}` : '';
      const msg = `🚨 **Novo Pedido de Acesso!**\n\n👤 *Usuário:* ${name}\n💼 *Cargo Solicitado:* ${role.toUpperCase()}${location}\n\nDeseja autorizar esta pessoa a receber os relatórios confidenciais?`;
      
      for (const dir of diretores) {
         await bot.telegram.sendMessage(dir.telegram_id, msg, {
            parse_mode: 'Markdown',
            reply_markup: {
               inline_keyboard: [[
                  { text: '✅ Aprovar', callback_data: `approve_role_${telegramId}` },
                  { text: '❌ Recusar', callback_data: `reject_role_${telegramId}` }
               ]]
            }
         }).catch(()=>{});
      }
   }
}

// ----------------------------------------------------
// RELATÓRIOS POR LOJA (Gerente / Subgerente)
// ----------------------------------------------------
async function runMorningReport(bot: Telegraf, user: any) {
   const today = new Date();
   today.setHours(0,0,0,0);
   const nowMs = Date.now();
   const { data: pendings } = await supabase.from('receiving_logs')
      .select('*')
      .eq('store_name', user.store_name)
      .in('status', ['pendente', 'aguardando_justificativa', 'album_pending'])
      .lt('created_at', today.toISOString());
      
   if (pendings && pendings.length > 0) {
      let msg = `🌅 *Bom dia, ${user.name}!*\nSua loja (**${user.store_name}**) iniciou o dia com **${pendings.length} pendências** antigas:\n\n`;
      pendings.forEach(p => {
         const op = (p.operation_type || 'COMPRA').toUpperCase();
         const waitingTime = formatDuration(nowMs - new Date(p.created_at).getTime());
         msg += `⏳ *${formatTicketLink(p)}* - ${p.supplier || 'Sem fornecedor'} [${op}]\n   └ Parado há: _${waitingTime}_\n`;
      });
      msg += `\n🎯 *Meta:* Tente zerar essas pendências logo cedo!`;
      await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' }).catch(()=>{});
   } else {
      await bot.telegram.sendMessage(user.telegram_id, `🌅 *Bom dia, ${user.name}!*\nSua loja (**${user.store_name}**) não tem nenhuma pendência de dias anteriores! Excelente trabalho! 🚀`, { parse_mode: 'Markdown' }).catch(()=>{});
   }
}

async function runEveningReport(bot: Telegraf, user: any) {
   const today = new Date();
   today.setHours(0,0,0,0);
   const tomorrow = new Date(today);
   tomorrow.setDate(tomorrow.getDate() + 1);
   const { data: todayLogs } = await supabase.from('receiving_logs')
      .select('*')
      .eq('store_name', user.store_name)
      .gte('created_at', today.toISOString())
      .lt('created_at', tomorrow.toISOString());
      
   if (todayLogs && todayLogs.length > 0) {
      const transfers = todayLogs.filter(l => l.operation_type === 'transferencia');
      const errors = transfers.filter(l => l.type === 'divergencia');
      const efficiency = getEfficiency(transfers.length, errors.length);
      
      let msg = `📊 *Fechamento Diário - ${user.store_name}*\n\n`;
      msg += `📦 Operações processadas hoje: **${todayLogs.length}**\n`;
      msg += `🔄 Transferências: **${transfers.length}**\n`;
      msg += `🎯 Eficiência Diária: **${efficiency}%** (Acertos de primeira)\n\n`;
      
      if (errors.length > 0) {
         msg += `⚠️ *Você teve ${errors.length} transferências SEM BONO (ou com ressalvas):*\n`;
         errors.forEach(e => {
            const justif = e.conclusion_observation ? e.conclusion_observation : (e.conclusion_status || 'Sem justificativa');
            msg += `- ${formatTicketLink(e)}: _${justif}_\n`;
         });
      } else {
         msg += `🌟 *PARABÉNS!* Todas as transferências de hoje deram certo de primeira!`;
      }
      await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' }).catch(()=>{});
   }
}

async function runWeeklyReport(bot: Telegraf, user: any) {
   const today = new Date();
   const lastWeek = new Date(today);
   lastWeek.setDate(lastWeek.getDate() - 7);
   
   const { data: weekLogs } = await supabase.from('receiving_logs')
      .select('*')
      .eq('store_name', user.store_name)
      .gte('created_at', lastWeek.toISOString());
      
   if (!weekLogs || weekLogs.length === 0) return;

   const transfers = weekLogs.filter(l => l.operation_type === 'transferencia');
   const errors = transfers.filter(l => l.type === 'divergencia');
   const efficiency = getEfficiency(transfers.length, errors.length);
   const pendings = weekLogs.filter(l => ['pendente', 'aguardando_justificativa', 'album_pending'].includes(l.status));
   
   // Calcular Tempo Médio de Resolução (SLA) para logs que tiveram divergência e foram resolvidos
   const resolvedErrors = errors.filter(e => e.resolved_at);
   let avgSlaText = 'N/A';
   if (resolvedErrors.length > 0) {
      let totalSlaMs = 0;
      resolvedErrors.forEach(e => {
         totalSlaMs += calculateSLA(e.created_at, e.resolved_at);
      });
      avgSlaText = formatDuration(totalSlaMs / resolvedErrors.length);
   }

   let msg = `🏆 *PLACAR SEMANAL - ${user.store_name}* 🏆\n`;
   msg += `_Resumo dos últimos 7 dias_\n\n`;
   msg += `📦 Total Processado: **${weekLogs.length}**\n`;
   msg += `✅ **Taxa de Acertos de Primeira:** **${efficiency}%**\n`;
   msg += `⏱️ **Tempo Médio de Resolução:** ${avgSlaText}\n`;
   msg += `⚠️ Pendências Acumuladas: **${pendings.length}**\n\n`;
   
   if (efficiency >= 95) {
      msg += `🚀 *Que semana incrível!* A loja rodou super redonda. Parabéns à equipe!`;
   } else if (efficiency >= 80) {
      msg += `👍 *Semana produtiva!* Mas podemos melhorar a atenção nas transferências para aumentar a taxa de acertos.`;
   } else {
      msg += `🚨 *Atenção!* A taxa de erros nas transferências está alta. Precisamos treinar mais os repositores e conferentes.`;
   }
   
   await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' }).catch(()=>{});
}

// ----------------------------------------------------
// RELATÓRIOS CONSOLIDADOS (Supervisor / Diretores)
// ----------------------------------------------------
async function runNetworkEveningReport(bot: Telegraf, user: any, targetDate?: Date) {
   // Ajuste robusto de Fuso Horário (Garante que a data seja de São Paulo, independente de onde o Docker esteja rodando)
   const baseDate = targetDate || new Date();
   
   // Formatar como YYYY-MM-DD na timezone do Brasil
   const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
   const spDateString = formatter.format(baseDate); // Ex: "2026-09-02"
   
   // Montar os limites de início (00:00:00 BRT = 03:00:00 UTC) e fim do dia
   // O formato ISO 8601 permite especificar o fuso (-03:00).
   const startOfDayBRT = `${spDateString}T00:00:00.000-03:00`;
   const endOfDayBRT = `${spDateString}T23:59:59.999-03:00`;
   
   const dateStr = targetDate ? spDateString.split('-').reverse().join('/') : 'Hoje';

   const { data: todayLogs } = await supabase.from('receiving_logs')
      .select('*')
      .gte('created_at', startOfDayBRT)
      .lte('created_at', endOfDayBRT);
      
   if (!todayLogs) return;

   const pendings = todayLogs.filter(l => ['pendente', 'aguardando_justificativa', 'album_pending'].includes(l.status));
   const transfers = todayLogs.filter(l => l.operation_type === 'transferencia');
   const errors = transfers.filter(l => l.type === 'divergencia');
   const efficiency = getEfficiency(transfers.length, errors.length);

   let msg = '';
   
   if (user.role === 'supervisor' || user.role === 'diretor_operacional' || user.role === 'analista_de_faturamento') {
      const resolved = todayLogs.filter(l => l.status === 'resolvido');
      const withoutRessalva = resolved.filter(l => l.conclusion_status === 'Aceite Total (Tudo conforme)');
      const withRessalva = resolved.filter(l => l.conclusion_status && l.conclusion_status !== 'Aceite Total (Tudo conforme)');
      
      const semBono = todayLogs.filter(l => l.type === 'divergencia');
      
      let avgTime = 0, fastest = 0, slowest = 0;
      if (resolved.length > 0) {
          const durations = resolved.map(l => {
             const start = new Date(l.created_at).getTime();
             const end = new Date(l.resolved_at || l.created_at).getTime();
             return Math.max(0, end - start);
          }).filter(d => d > 0);
          
          if (durations.length > 0) {
             fastest = Math.min(...durations);
             slowest = Math.max(...durations);
             avgTime = durations.reduce((a,b)=>a+b, 0) / durations.length;
          }
      }

      msg += `📊 *Boletim Operacional Consolidado (${dateStr})*\n\n`;
      msg += `📦 **Total de Operações Geradas:** ${todayLogs.length}\n`;
      msg += `✅ **Total de Tickets Concluídos:** ${resolved.length}\n`;
      msg += `  └ Sem Ressalvas (Limpos): ${withoutRessalva.length}\n`;
      msg += `  └ Com Ressalvas (Problemas): ${withRessalva.length}\n`;
      msg += `⚠️ **Entregas s/ Bono Prévio:** ${semBono.length} (Tiveram que fazer na hora)\n\n`;
      
      if (resolved.length > 0) {
         msg += `⏱️ **Performance de Resolução**\n`;
         msg += `  └ Tempo Médio: ${formatDuration(avgTime)}\n`;
         msg += `  └ Mais Rápida: ${formatDuration(fastest)}\n`;
         msg += `  └ Mais Demorada: ${formatDuration(slowest)}\n\n`;
      }
      
      // Ranking de erros (mais errou)
      const storeErrors: Record<string, number> = {};
      semBono.forEach(e => { storeErrors[e.store_name] = (storeErrors[e.store_name] || 0) + 1; });
      const sortedStores = Object.entries(storeErrors).sort((a,b)=>b[1]-a[1]);
      
      if (sortedStores.length > 0) {
         msg += `🏆 *Lojas que mais atrasaram Bonos (Top 3):*\n`;
         sortedStores.slice(0, 3).forEach(([store, count], i) => {
            msg += `🚨 ${i+1}º - ${store} (${count} notas atrasadas)\n`;
         });
      } else {
         msg += `🌟 *Rede Impecável!* Nenhuma entrega sem bono ${dateStr.toLowerCase()}.\n`;
      }
      
      // Ranking de lentidão (Lojas com pendências abertas há mais tempo)
      if (pendings.length > 0) {
         const now = Date.now();
         msg += `\n⏱️ *Radar de Lentidão (Pendências mais velhas):*\n`;
         const sortedPendings = [...pendings].sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
         sortedPendings.slice(0, 3).forEach(p => {
             const age = formatDuration(now - new Date(p.created_at).getTime());
             msg += `- ${p.store_name} (Nota ${formatTicketLink(p)}) está parada há ${age}\n`;
         });
      }
   }
   else if (user.role === 'diretor_financeiro') {
      let totalValuePending = 0;
      pendings.forEach(p => { if(p.invoice_value) totalValuePending += p.invoice_value; });
      
      msg += `💰 *Boletim Financeiro (Pendências)*\n\n`;
      msg += `No dia (${dateStr}) tivemos **${todayLogs.length} operações** na rede.\n`;
      msg += `Atualmente temos **${pendings.length} tickets parados** aguardando alguma ação.\n`;
      msg += `Valor total estimado retido: **R$ ${totalValuePending.toFixed(2)}**.\n`;
   }
   else if (user.role === 'diretor_comercial') {
      const purchases = todayLogs.filter(l => l.operation_type !== 'transferencia');
      const errPurchases = purchases.filter(l => l.type === 'divergencia');
      const purchEff = getEfficiency(purchases.length, errPurchases.length);
      
      msg += `🤝 *Boletim Comercial (Fornecedores) - ${dateStr}*\n\n`;
      msg += `Recebemos **${purchases.length} notas de compras externas**.\n`;
      msg += `Eficiência de Entrega (Sem divergência): **${purchEff}%**\n`;
   }
   else if (user.role === 'diretor_administrativo') {
      msg += `🏢 *Visão Administrativa Geral*\n\n`;
      msg += `Total de Movimentações Registradas: **${todayLogs.length}**\n`;
      msg += `Tickets Pendentes de Solução: **${pendings.length}**\n`;
      msg += `Eficiência Operacional da Rede: **${efficiency}%**\n`;
   }
   
   if (msg) {
      await bot.telegram.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' }).catch(()=>{});
   }
}
