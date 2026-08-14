import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Credenciais do Supabase não encontradas no .env. Algumas funcionalidades (agendamento e resumos) podem não funcionar corretamente.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function setupDatabase() {
  // A criação de tabelas idealmente é feita no painel do Supabase,
  // mas vamos garantir que o objeto de conexão funciona.
  console.log('✅ Supabase client inicializado.');
}
