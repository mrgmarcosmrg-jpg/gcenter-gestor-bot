import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from '../database/db';

async function lockGroup(bot: Telegraf, chatId: string | number, lock: boolean) {
  return bot.telegram.setChatPermissions(chatId, {
    can_send_messages: !lock,
    can_send_audios: !lock,
    can_send_documents: !lock,
    can_send_photos: !lock,
    can_send_videos: !lock,
    can_send_video_notes: !lock,
    can_send_voice_notes: !lock,
    can_send_polls: !lock,
    can_send_other_messages: !lock
  });
}
export function setupSilenceManager(bot: Telegraf) {
  // Escuta quando o bot é adicionado a um grupo para registrar no banco de dados
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    const newStatus = ctx.myChatMember.new_chat_member.status;
    
    if (chat.type === 'group' || chat.type === 'supergroup') {
      if (newStatus === 'member' || newStatus === 'administrator') {
        // Registra o grupo
        await supabase.from('groups_config').upsert({
          chat_id: chat.id.toString(),
          title: chat.title,
          start_time: '06:00',
          end_time: '20:00',
          active: true
        });
        console.log(`Bot adicionado ao grupo: ${chat.title}`);
      } else if (newStatus === 'left' || newStatus === 'kicked') {
        // Marca como inativo
        await supabase.from('groups_config').update({ active: false }).eq('chat_id', chat.id.toString());
      }
    }
  });

  // Comando para o admin configurar o horário
  bot.command('horario', async (ctx) => {
    if (ctx.chat.type === 'private') return;
    
    const admins = await ctx.getChatAdministrators();
    const isAdmin = admins.some(admin => admin.user.id === ctx.from.id);
    if (!isAdmin) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length !== 3) {
      return ctx.reply('Uso correto: /horario 06:00 20:00');
    }

    const startTime = parts[1];
    const endTime = parts[2];

    await supabase.from('groups_config').upsert({
      chat_id: ctx.chat.id.toString(),
      title: ctx.chat.title,
      start_time: startTime,
      end_time: endTime,
      active: true
    });

    ctx.reply(`Horário de expediente configurado: das ${startTime} às ${endTime}. Fora desse horário o grupo será silenciado.`);
  });

  // Guarda em memória o último estado aplicado por grupo para NÃO chamar a API do Telegram a cada minuto sem necessidade
  const lastLockState = new Map<string, boolean>();

  // Job a cada minuto para verificar quem silenciar ou liberar
  cron.schedule('* * * * *', async () => {
    const { data: groups } = await supabase.from('groups_config').select('*').eq('active', true);
    if (!groups) return;

    const now = new Date();
    const options = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false } as const;
    const currentTimeStr = now.toLocaleTimeString('pt-BR', options);

    for (const group of groups) {
      // Não altera permissões de grupos operacionais de tickets (Faturamento, Recebimento, Auditoria)
      if (group.sector && ['faturamento', 'recebimento', 'auditoria', 'auditoria_devolucoes'].includes(group.sector)) {
        continue;
      }
      if (!group.start_time || !group.end_time) continue;

      const isWorkHours = (currentTimeStr >= group.start_time && currentTimeStr < group.end_time);
      const shouldLock = !isWorkHours;

      if (lastLockState.get(group.chat_id) === shouldLock) {
        continue; // Estado já aplicado, evita gastar limite da API do Telegram
      }

      try {
        await lockGroup(bot, group.chat_id, shouldLock);
        lastLockState.set(group.chat_id, shouldLock);
      } catch (error: any) {
        const desc = error?.response?.description || '';
        if (desc.includes('upgraded to a supergroup')) {
          await supabase.from('groups_config').update({ active: false }).eq('chat_id', group.chat_id);
        }
        lastLockState.set(group.chat_id, shouldLock);
      }
    }

    const generalGroupId = process.env.GENERAL_GROUP_ID;
    if (generalGroupId) {
      const isWorkHours = (currentTimeStr >= '07:00' && currentTimeStr < '20:00');
      const shouldLock = !isWorkHours;
      if (lastLockState.get(generalGroupId) !== shouldLock) {
        try {
          await lockGroup(bot, generalGroupId, shouldLock);
          lastLockState.set(generalGroupId, shouldLock);
        } catch (error) {
          lastLockState.set(generalGroupId, shouldLock);
        }
      }
    }
  }, {
    timezone: "America/Sao_Paulo"
  });
}
