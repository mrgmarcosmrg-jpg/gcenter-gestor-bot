import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

async function check() {
  const { data } = await supabase.from('groups_config').select('chat_id, title');
  console.log('=== GRUPOS NO SUPABASE ===');
  data?.forEach(g => console.log(g.chat_id + ' | ' + g.title));
}
check();
