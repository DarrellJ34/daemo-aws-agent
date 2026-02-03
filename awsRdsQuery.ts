import mysql from "mysql2/promise";

// RDS is the MySQL database server in AWS.
// Connect using host, username, password, and port.
// You can also use these credentials in a SQL client.

const defaultPort = 3306; // Default MySQL port in AWS

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function isReadOnlySql(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return (
    normalized.startsWith("select ") ||
    normalized.startsWith("show ") ||
    normalized.startsWith("describe ") ||
    normalized.startsWith("desc ")
  );
}

export type rdsQueryResult = {
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, any>>;
};

export async function queryMysqlRds(
  sql: string,
  maxRows: number
): Promise<rdsQueryResult> {
  if (!isReadOnlySql(sql)) {
    throw new Error("OnlyReadQueriesAllowed");
  }

  const host = getRequiredEnv("RDS_HOST");
  const user = getRequiredEnv("RDS_USER");
  const password = getRequiredEnv("RDS_PASSWORD");
  const database = process.env.RDS_DB;
  const port = process.env.RDS_PORT ? Number(process.env.RDS_PORT) : defaultPort;

  const connection = await mysql.createConnection({
    host,
    user,
    password,
    database,
    port,
    ssl: process.env.RDS_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });

  try {
    const [rows] = await connection.query({
      sql,
      rowsAsArray: false,
    });

    const resultRows = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    const columns =
      resultRows.length > 0 ? Object.keys(resultRows[0] as Record<string, any>) : [];

    return {
      rowCount: resultRows.length,
      columns,
      rows: resultRows as Array<Record<string, any>>,
    };
  } finally {
    await connection.end();
  }
}
