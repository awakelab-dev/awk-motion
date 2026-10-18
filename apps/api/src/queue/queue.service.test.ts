import { describe, expect, it } from 'vitest';
import { QueueService, type TaskSpec } from './queue.service.js';

/** BD falsa: lo justo para la cola (crear, actualizar y tomar por prioridad + orden de llegada). */
function fakeDb() {
  const rows = new Map<string, { id: string; resource: string; status: string; priority: Date; seq: number }>();
  let seq = 0;
  return {
    rows,
    queueTask: {
      create: async ({ data }: { data: { resource: string; priority: Date } }) => {
        const id = `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
        rows.set(id, { id, resource: data.resource, status: 'queued', priority: data.priority, seq });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: { status?: string } }) => {
        const r = rows.get(where.id)!;
        if (data.status) r.status = data.status;
        return r;
      },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    $queryRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      const [resource, ids] = v.slice(-2) as [string, string[]];
      const c = [...rows.values()]
        .filter((r) => r.resource === resource && r.status === 'queued' && ids.includes(r.id))
        .sort((a, b) => a.priority.getTime() - b.priority.getTime() || a.seq - b.seq)[0];
      if (!c) return [];
      c.status = 'running';
      return [{ id: c.id }];
    },
  };
}

const spec = (priority: number, target: string, resource: TaskSpec['resource'] = 'minimax'): TaskSpec => ({
  resource,
  kind: 'video',
  target,
  ownerId: 'u',
  generationId: `g${priority}`,
  priority,
});
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('cola global (ADR-045)', () => {
  it('con un hueco libre atiende primero al video lanzado antes, aunque su trabajo llegue después', async () => {
    const db = fakeDb();
    const q = new QueueService(db as never);
    q.onModuleInit();
    (q.capacity('minimax') as unknown as { effective: number }).effective = 1;
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(spec(3, 'v3-clip1'), () => new Promise<void>((r) => ((release = r), order.push('v3-clip1'))));
    await tick();
    // Mientras v3 ocupa el único hueco llegan trabajos de v4 y, después, una corrección del video 1.
    const others = [q.run(spec(4, 'v4-clip1'), async () => void order.push('v4-clip1')), q.run(spec(4, 'v4-clip2'), async () => void order.push('v4-clip2'))];
    await tick();
    const fix = q.run(spec(1, 'v1-correccion'), async () => void order.push('v1-correccion'));
    await tick();
    release();
    await Promise.all([first, fix, ...others]);
    expect(order).toEqual(['v3-clip1', 'v1-correccion', 'v4-clip1', 'v4-clip2']);
  });

  it('un error definitivo solo afecta a su trabajo y la cola sigue', async () => {
    const q = new QueueService(fakeDb() as never);
    q.onModuleInit();
    const bad = q.run(spec(1, 'malo'), async () => {
      throw new Error('HTTP 400 en api.minimax.io: invalid prompt');
    });
    const good = q.run(spec(2, 'bueno'), async () => 'ok');
    await expect(bad).rejects.toThrow('invalid prompt');
    await expect(good).resolves.toBe('ok');
  });

  it('un 429 espera (Retry-After) y se reintenta sin fallar', async () => {
    const q = new QueueService(fakeDb() as never);
    q.onModuleInit();
    let calls = 0;
    const t0 = Date.now();
    const out = await q.run(spec(1, 'img', 'openai'), async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('HTTP 429 rate limit'), { retryAfterMs: 50 });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  }, 60_000);
});
