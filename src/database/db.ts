import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || '';

if (!connectionString) {
  console.warn('⚠️ DATABASE_URL não configurada no .env. A aplicação pode falhar.');
}

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

class QueryBuilder {
  private table: string;
  private pool: Pool;
  private action: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
  private selects: string = '*';
  private updates: any = null;
  private inserts: any = null;
  private wheres: string[] = [];
  private params: any[] = [];
  private orderCol: string | null = null;
  private orderAsc: boolean = true;
  private limitNum: number | null = null;
  private isSingle: boolean = false;

  constructor(table: string, pool: Pool) {
    this.table = table;
    this.pool = pool;
  }

  select(columns: string = '*') {
    if (this.action !== 'insert' && this.action !== 'update' && this.action !== 'upsert' && this.action !== 'delete') {
       this.action = 'select';
    }
    this.selects = columns;
    return this;
  }

  update(obj: any) {
    this.action = 'update';
    this.updates = obj;
    return this;
  }

  insert(obj: any) {
    this.action = 'insert';
    this.inserts = obj;
    return this;
  }

  upsert(obj: any) {
    this.action = 'upsert';
    this.inserts = obj;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  eq(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} = $${this.params.length}`);
    return this;
  }

  ilike(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} ILIKE $${this.params.length}`);
    return this;
  }

  in(col: string, arr: any[]) {
    if (!arr || arr.length === 0) {
        this.wheres.push(`1 = 0`);
        return this;
    }
    const placeholders = arr.map(val => {
        this.params.push(val);
        return `$${this.params.length}`;
    });
    this.wheres.push(`${col} IN (${placeholders.join(', ')})`);
    return this;
  }

  gte(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} >= $${this.params.length}`);
    return this;
  }

  lte(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} <= $${this.params.length}`);
    return this;
  }

  lt(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} < $${this.params.length}`);
    return this;
  }

  like(col: string, val: any) {
    this.params.push(val);
    this.wheres.push(`${col} LIKE $${this.params.length}`);
    return this;
  }

  is(col: string, val: any) {
    if (val === null) {
      this.wheres.push(`${col} IS NULL`);
    } else {
      this.wheres.push(`${col} IS ${val}`);
    }
    return this;
  }

  single() {
    this.isSingle = true;
    this.limitNum = 1;
    return this;
  }

  maybeSingle() {
    this.isSingle = true;
    this.limitNum = 1;
    return this;
  }

  order(col: string, opts: { ascending?: boolean } = { ascending: true }) {
    this.orderCol = col;
    this.orderAsc = opts.ascending ?? true;
    return this;
  }

  limit(n: number) {
    this.limitNum = n;
    return this;
  }

  async execute() {
    let sql = '';
    
    if (this.action === 'select') {
       sql = `SELECT ${this.selects} FROM ${this.table}`;
       if (this.wheres.length > 0) sql += ` WHERE ` + this.wheres.join(' AND ');
       if (this.orderCol) sql += ` ORDER BY ${this.orderCol} ${this.orderAsc ? 'ASC' : 'DESC'}`;
       if (this.limitNum) sql += ` LIMIT ${this.limitNum}`;
    } else if (this.action === 'update') {
       const keys = Object.keys(this.updates);
       const sets = keys.map(k => {
           this.params.push(this.updates[k]);
           return `${k} = $${this.params.length}`;
       });
       sql = `UPDATE ${this.table} SET ${sets.join(', ')}`;
       if (this.wheres.length > 0) sql += ` WHERE ` + this.wheres.join(' AND ');
       sql += ` RETURNING *`;
    } else if (this.action === 'insert') {
       const keys = Object.keys(this.inserts);
       const vals = keys.map(k => {
           this.params.push(this.inserts[k]);
           return `$${this.params.length}`;
       });
       sql = `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`;
    } else if (this.action === 'delete') {
       sql = `DELETE FROM ${this.table}`;
       if (this.wheres.length > 0) sql += ` WHERE ` + this.wheres.join(' AND ');
       sql += ` RETURNING *`;
    } else if (this.action === 'upsert') {
       const keys = Object.keys(this.inserts);
       const vals = keys.map(k => {
           this.params.push(this.inserts[k]);
           return `$${this.params.length}`;
       });
       let conflictKey = 'id';
       if (this.table === 'groups_config') conflictKey = 'chat_id';
       if (this.table === 'user_roles') conflictKey = 'telegram_id';
       
       const sets = keys.filter(k => k !== conflictKey).map(k => `${k} = EXCLUDED.${k}`);

       sql = `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT (${conflictKey}) DO UPDATE SET ${sets.join(', ')} RETURNING *`;
    }

    try {
        const result = await this.pool.query(sql, this.params);
        if (this.action === 'select') {
            if (this.isSingle) {
                return { data: result.rows.length > 0 ? result.rows[0] : null, error: null };
            }
            return { data: result.rows, error: null };
        }
        return { data: result.rows, error: null };
    } catch (e) {
        console.error('Adapter DB Error:', e, sql, this.params);
        return { data: null, error: e };
    }
  }

  // Faz a classe funcionar como uma Promise para que o 'await supabase...' nativo funcione sem alterações!
  then<TResult1 = any, TResult2 = never>(
    resolve?: ((value: any) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(resolve, reject);
  }
}

// O objeto exportado simula perfeitamente a interface do Supabase
export const supabase = {
   from: (table: string) => new QueryBuilder(table, pool)
};

export async function setupDatabase() {
  try {
    console.log('📦 Inicializando banco de dados nativo PostgreSQL...');
    const client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS groups_config (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        chat_id VARCHAR(255) UNIQUE NOT NULL,
        sector VARCHAR(100),
        title VARCHAR(255),
        store_name VARCHAR(255),
        active BOOLEAN DEFAULT TRUE,
        start_time VARCHAR(10) DEFAULT '08:00',
        end_time VARCHAR(10) DEFAULT '18:00',
        manager_username VARCHAR(255)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        telegram_id VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255),
        first_name VARCHAR(255),
        role VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS receiving_logs (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        chat_id VARCHAR(255),
        recebimento_thread_id VARCHAR(255),
        thread_id VARCHAR(255),
        store_name VARCHAR(255),
        requester_name VARCHAR(255),
        original_message_id TEXT,
        status VARCHAR(100),
        type VARCHAR(100),
        operation_type VARCHAR(100),
        supplier VARCHAR(255),
        invoice_value NUMERIC(15,2),
        problem_description TEXT,
        physical_receipt_at TIMESTAMP WITH TIME ZONE,
        assumed_by VARCHAR(255),
        bono_sent BOOLEAN DEFAULT FALSE,
        resolved_by VARCHAR(255),
        conclusion_status VARCHAR(255),
        conclusion_observation TEXT,
        resolved_at TIMESTAMP WITH TIME ZONE,
        analyst_notified BOOLEAN DEFAULT FALSE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        store_name VARCHAR(255),
        month_year VARCHAR(10),
        goal_amount NUMERIC(15,2)
      );
    `);

    client.release();
    console.log('✅ Tabelas criadas/verificadas com sucesso no PostgreSQL Nativo.');
  } catch (error) {
    console.error('❌ Erro ao configurar o banco de dados:', error);
  }
}
