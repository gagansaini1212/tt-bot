import postgres, { type Sql } from "postgres";

export type Database = Sql<Record<string, never>>;

export function createDatabase(
  connectionString = process.env.DATABASE_URL,
): Database {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function withCustomerScope<T>(
  database: Database,
  customerId: string,
  work: (
    transaction: postgres.TransactionSql<Record<string, never>>,
  ) => Promise<T>,
): Promise<T> {
  return database.begin(async (transaction) => {
    await transaction`select set_config('app.current_customer_id', ${customerId}, true)`;
    return work(transaction);
  }) as unknown as Promise<T>;
}
