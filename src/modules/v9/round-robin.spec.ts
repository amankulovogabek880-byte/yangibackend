/**
 * RoundRobinService unit tests
 *
 * Joriy servis API'siga mos (getNextAgent / assignNewLead / assignUnassigned).
 * Eslatma: MANUAL/ROUND_ROBIN strategiyasi RoundRobinService ICHIDA emas,
 * uni chaqiruvchi joyda (masalan leads.module.ts) tekshiriladi — shu sabab
 * bu yerda faqat servisning o'zi mas'ul bo'lgan narsalar sinaladi:
 *   - navbat bilan aylanma tayinlash (round robin)
 *   - pauzadagi agentlarni o'tkazib yuborish
 *   - kunlik limitni hisobga olish
 *   - agent topilmasa null qaytarish
 */

import { RoundRobinService } from './round-robin.module';

// ─── Mock builder ─────────────────────────────────────────────
function makeAgents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i + 1}`,
    lastAssignedAt: null as Date | null,
    dailyLeadLimit: 0,
  }));
}

function buildPrisma(opts: {
  agents?: any[];
  todayClientCount?: number;
}) {
  const agents = opts.agents ?? makeAgents(3);
  const todayCount = opts.todayClientCount ?? 0;
  const updatedLastAssigned: Record<string, Date> = {};

  return {
    user: {
      findMany: jest.fn().mockImplementation(() =>
        Promise.resolve(
          agents.map((a) => ({
            ...a,
            lastAssignedAt: updatedLastAssigned[a.id] ?? a.lastAssignedAt,
          })),
        ),
      ),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        updatedLastAssigned[where.id] = data.lastAssignedAt;
        return Promise.resolve({});
      }),
    },
    client: {
      count: jest.fn().mockResolvedValue(todayCount),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    clientTimeline: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function buildService(prisma: any): RoundRobinService {
  const notifications = { create: jest.fn().mockResolvedValue({}) } as any;
  const audit = { log: jest.fn() } as any;
  return new RoundRobinService(prisma as any, notifications, audit);
}

// ─── Tests ────────────────────────────────────────────────────

describe('RoundRobinService', () => {
  describe('getNextAgent() — asosiy aylanma tayinlash', () => {
    it('agent1 oladi birinchi leadni', async () => {
      const prisma = buildPrisma({});
      const svc = buildService(prisma);
      const result = await svc.getNextAgent('tenant-1');
      expect(result).toBe('agent-1');
    });

    it("to'liq aylanma: lead1→ag1, lead2→ag2, lead3→ag3, lead4→ag1", async () => {
      const prisma = buildPrisma({});
      const svc = buildService(prisma);

      const r1 = await svc.getNextAgent('tenant-1');
      const r2 = await svc.getNextAgent('tenant-1');
      const r3 = await svc.getNextAgent('tenant-1');
      const r4 = await svc.getNextAgent('tenant-1'); // yana birinchisiga

      expect(r1).toBe('agent-1');
      expect(r2).toBe('agent-2');
      expect(r3).toBe('agent-3');
      expect(r4).toBe('agent-1');
    });

    it("bitta agent bo'lsa ham to'g'ri ishlaydi", async () => {
      const prisma = buildPrisma({ agents: makeAgents(1) });
      const svc = buildService(prisma);

      const r1 = await svc.getNextAgent('tenant-1');
      const r2 = await svc.getNextAgent('tenant-1');
      expect(r1).toBe('agent-1');
      expect(r2).toBe('agent-1');
    });

    it("agent bo'lmasa null qaytaradi", async () => {
      const prisma = buildPrisma({ agents: [] });
      const svc = buildService(prisma);
      const result = await svc.getNextAgent('tenant-1');
      expect(result).toBeNull();
    });
  });

  describe('dailyLeadLimit — kunlik limit', () => {
    it('limitga yetgan agent otkazib yuboriladi, keyingisi tanlanadi', async () => {
      const agents = makeAgents(3);
      agents[0].dailyLeadLimit = 5; // agent-1 limitga yetdi

      const prisma = buildPrisma({ agents, todayClientCount: 5 });
      const svc = buildService(prisma);

      const result = await svc.getNextAgent('tenant-1');
      expect(result).toBe('agent-2');
    });

    it('limit=0 cheksiz deb hisoblanadi', async () => {
      const agents = makeAgents(1);
      agents[0].dailyLeadLimit = 0;

      const prisma = buildPrisma({ agents, todayClientCount: 1000 });
      const svc = buildService(prisma);

      const result = await svc.getNextAgent('tenant-1');
      expect(result).toBe('agent-1');
    });

    it('barcha agent limitga yetsa null qaytaradi', async () => {
      const agents = makeAgents(2);
      agents[0].dailyLeadLimit = 3;
      agents[1].dailyLeadLimit = 3;

      const prisma = buildPrisma({ agents, todayClientCount: 3 });
      const svc = buildService(prisma);

      const result = await svc.getNextAgent('tenant-1');
      expect(result).toBeNull();
    });
  });

  describe('assignNewLead() — toliq tayinlash oqimi', () => {
    it('clientni yangilaydi va agent ID qaytaradi', async () => {
      const prisma = buildPrisma({});
      const svc = buildService(prisma);

      const agentId = await svc.assignNewLead({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        clientName: 'Aziz Aliyev',
        source: 'WEBSITE',
      });

      expect(agentId).toBe('agent-1');
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { assignedAgentId: 'agent-1' },
      });
    });

    it("agent topilmasa clientni yangilamaydi, null qaytaradi", async () => {
      const prisma = buildPrisma({ agents: [] });
      const svc = buildService(prisma);

      const agentId = await svc.assignNewLead({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        clientName: 'Aziz Aliyev',
      });

      expect(agentId).toBeNull();
      expect(prisma.client.update).not.toHaveBeenCalled();
    });
  });

  describe('assignUnassigned() — admin qayta taqsimlash', () => {
    it('tayinlanmagan leadlarni agentlarga taqsimlaydi', async () => {
      const unassigned = [
        { id: 'c1', fullName: 'Client 1', source: 'WEB' },
        { id: 'c2', fullName: 'Client 2', source: 'WEB' },
      ];

      const prisma = buildPrisma({});
      prisma.client.findMany = jest.fn().mockResolvedValue(unassigned);

      const svc = buildService(prisma);
      const result = await svc.assignUnassigned('tenant-1');

      expect(result.assigned).toBe(2);
      expect(result.skipped).toBe(0);
      expect(prisma.client.update).toHaveBeenCalledTimes(2);
    });

    it("agent bolmasa hammasini skipped deb belgilaydi", async () => {
      const unassigned = [{ id: 'c1', fullName: 'Client 1', source: 'WEB' }];

      const prisma = buildPrisma({ agents: [] });
      prisma.client.findMany = jest.fn().mockResolvedValue(unassigned);

      const svc = buildService(prisma);
      const result = await svc.assignUnassigned('tenant-1');

      expect(result.assigned).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});