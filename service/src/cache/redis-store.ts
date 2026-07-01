/**
 * cache/redis-store.ts — 실제 Redis 어댑터 (ioredis) + 선택 팩토리
 *
 * 역할: 기존 CacheClient 포트(unfurl-cache.ts)의 Redis 구현체.
 *   2단계 키(og:map / og:pl / og:neg / og:lock)·SWR(TTL 조회)·single-flight(SET NX EX)의
 *   **오케스트레이션은 unfurl-cache.ts가 소유**하고, 이 파일은 그 포트를 Redis 명령으로 번역하는
 *   얇은 트랜스포트일 뿐이다(어댑터는 인터페이스 뒤에서 교체 — 코어 로직 불변).
 *     - get(k)              → GET k
 *     - setEx(k,v,ttl)      → SET k v EX ttl          (payload/map/neg 물리 TTL 저장 = SWR 창 포함)
 *     - setNx(k,v,ttl)      → SET k v EX ttl NX        (single-flight 락)
 *     - del(k)              → DEL k
 *
 * 선택: 팩토리 createCacheClient() 가 REDIS_URL 유무로 어댑터를 고른다.
 *   - REDIS_URL 있음 + 접속 성공 → IoredisCacheClient
 *   - REDIS_URL 없음 / ioredis 미설치 / 접속 실패 → InMemoryCacheClient (graceful fallback)
 *
 * 내구성: 런타임 Redis 블립에도 요청이 죽지 않도록 어댑터 메서드는 트랜스포트 예외를 삼킨다
 *   (read→miss, write→noop, lock→fail-open). 시작 시 접속 실패는 인메모리로 완전 강등한다.
 *
 * ioredis 는 dependency 지만, 타입/설치 여부와 무관하게 typecheck 가 통과하도록 동적 import
 *   (`import('ioredis' as string)`)로 로드한다 — 실 의존성 없이도 빌드/스모크가 성립해야 하므로.
 */

import { InMemoryCacheClient, type CacheClient } from './unfurl-cache.js';

/** 이 어댑터가 사용하는 ioredis Redis 인스턴스의 최소 형태(로컬 구조 타입). */
interface RedisLike {
  get(key: string): Promise<string | null>;
  // ioredis SET 은 가변 인자(EX/NX 등). 반환 'OK' | null.
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  del(key: string): Promise<number>;
  ping(): Promise<string>;
  connect(): Promise<void>;
  quit(): Promise<string>;
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** ioredis 생성자의 최소 형태. */
type RedisCtor = new (url: string, opts?: Record<string, unknown>) => RedisLike;

/** 팩토리 반환 — 선택된 클라이언트 + 종류 + 정리 훅. */
export interface CacheHandle {
  client: CacheClient;
  kind: 'redis' | 'memory';
  close(): Promise<void>;
}

/** CacheClient 의 Redis 구현체. 트랜스포트 예외는 삼켜 요청 가용성을 지킨다. */
export class IoredisCacheClient implements CacheClient {
  constructor(private redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch {
      // 블립 → miss 로 취급(상위 로직이 재크롤). SSRF/정확성엔 영향 없음.
      return null;
    }
  }

  async setEx(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      // 물리 TTL 은 unfurl-cache 가 이미 SWR 창(논리 TTL×(1+ratio))을 반영해 넘긴다.
      await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSec)));
    } catch {
      /* write best-effort — 실패해도 다음 요청에서 재기록 */
    }
  }

  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    try {
      const res = await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSec)), 'NX');
      return res === 'OK';
    } catch {
      // fail-open: 락 획득으로 간주해 요청이 최소 1회 크롤되도록(가용성 우선). 블립 시 잠깐 herd 가능.
      return true;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      /* 락 해제 실패 → LOCK_TTL_SEC 로 자동 만료 */
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const memoryHandle = (): CacheHandle => ({
  client: new InMemoryCacheClient(),
  kind: 'memory',
  close: async () => {},
});

/**
 * 캐시 클라이언트 선택 팩토리.
 * @param opts.url  명시 URL(미지정 시 REDIS_URL → OG_REDIS_URL 순으로 env 조회. 둘 다 없으면 인메모리).
 *
 * ASSUMPTION: 선택 기준은 "REDIS_URL 존재"다. config 의 OG_REDIS_URL 은 항상 기본값을 갖지만
 *   그것은 dev 인메모리를 강제로 Redis 로 바꾸지 않는다(무설정 dev = 외부 의존 0 불변식 보존).
 */
export async function createCacheClient(opts: { url?: string; probeMs?: number } = {}): Promise<CacheHandle> {
  const url = opts.url ?? process.env.REDIS_URL;
  if (!url) return memoryHandle();

  try {
    const mod = (await import('ioredis' as string)) as { default?: RedisCtor } & RedisCtor;
    const Redis: RedisCtor = (mod.default ?? (mod as unknown as RedisCtor));
    const redis: RedisLike = new Redis(url, {
      lazyConnect: true, // 접속을 명시적으로 제어(probe 후 fallback 판단)
      connectTimeout: 2000,
      maxRetriesPerRequest: 2, // 명령이 무한 대기하지 않도록
      enableOfflineQueue: true,
      // 시작 probe 는 짧게 재시도하다 포기(그러면 인메모리로 강등).
      retryStrategy: (times: number) => (times > 8 ? null : Math.min(times * 150, 1500)),
    });
    // ioredis 는 'error' 리스너가 없으면 unhandled 로 프로세스를 흔들 수 있음.
    redis.on('error', () => {
      /* 개별 커넥션 에러는 어댑터 메서드 catch 로 흡수 */
    });

    await withTimeout(redis.connect(), opts.probeMs ?? 3000, 'redis connect');
    await withTimeout(redis.ping(), 1500, 'redis ping');

    const client = new IoredisCacheClient(redis);
    return { client, kind: 'redis', close: () => client.close() };
  } catch (err) {
    // ioredis 미설치 / 접속 실패 → 완전 강등(개발/CI 에서 실 Redis 없이도 기동).
    process.stderr.write(
      `[redis-store] REDIS_URL 설정됨이나 접속 실패 → 인메모리 캐시로 강등: ${(err as Error).message}\n`,
    );
    return memoryHandle();
  }
}
