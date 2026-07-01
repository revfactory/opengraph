/**
 * scripts/migrate.ts — migrations/*.sql 순서 적용기 (멱등)
 *
 * 실행: npm run migrate  (DATABASE_URL 필요)
 *   - migrations/ 의 *.sql 을 파일명 오름차순으로 적용.
 *   - schema_migrations(filename PK) 로 이미 적용된 파일은 건너뜀.
 *   - 각 파일은 단일 트랜잭션(BEGIN/COMMIT) — 부분 적용 방지.
 *   - docker-compose 의 one-shot `migrate` 서비스가 app 기동 전에 호출한다.
 *
 * `pg` 는 동적 import(설치 여부와 무관한 typecheck). DATABASE_URL 미설정 시 명확히 에러 후 종료.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}
interface PoolLike {
  connect(): Promise<ClientLike>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
type PoolCtor = new (config: Record<string, unknown>) => PoolLike;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  // DATABASE_URL 우선(정본). 보조로 OG_POSTGRES_URL 도 허용.
  const target = process.env.DATABASE_URL ?? process.env.OG_POSTGRES_URL;
  if (!target) {
    process.stderr.write('[migrate] DATABASE_URL(또는 OG_POSTGRES_URL) 미설정 — 적용할 대상 없음.\n');
    process.exit(1);
    return;
  }

  const mod = (await import('pg' as string)) as { default?: { Pool: PoolCtor }; Pool?: PoolCtor };
  const Pool: PoolCtor = (mod.Pool ?? mod.default?.Pool) as PoolCtor;
  const pool = new Pool({ connectionString: target, max: 2, connectionTimeoutMillis: 5000 });

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => String(r.filename)),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        process.stdout.write(`[migrate] skip  ${file} (이미 적용)\n`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`[migrate] apply ${file} ...\n`);
      // 트랜잭션은 반드시 단일 커넥션에서: pool.query 는 호출마다 커넥션이 달라질 수 있어 BEGIN/COMMIT 이 갈린다.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql); // simple 프로토콜(무파라미터) — 세미콜론 다중 statement 허용
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran += 1;
        process.stdout.write(`[migrate] done  ${file}\n`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    process.stdout.write(`[migrate] 완료 — ${ran}개 적용 / ${files.length}개 중.\n`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  process.stderr.write(`[migrate] 실패: ${(e as Error).message}\n`);
  process.exit(1);
});
