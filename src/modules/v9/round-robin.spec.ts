// /**
//  * RoundRobinService unit tests
//  *
//  * Proves:
//  *   lead1 → agent1
//  *   lead2 → agent2
//  *   lead3 → agent3
//  *   lead4 → agent1 (back to first)
//  *
//  * And:
//  *   MANUAL strategy → null (no auto assignment)
//  *   Paused agents skipped
//  *   Daily limit respected
//  */

// import { RoundRobinService } from './round-robin.module';

// // ─── Mock builder ─────────────────────────────────────────────
// function makeAgents(count: number) {
//   return Array.from({ length: count }, (_, i) => ({
//     id: `agent-${i + 1}`,
//     lastAssignedAt: null as Date | null,
//     dailyLeadLimit: 0,
//     isPausedFromAssignment: false,
//     status: 'ACTIVE',
//     role: 'AGENT',
//   }));
// }

// function buildPrisma(opts: {
//   agents?: any[];
//   strategy?: string;
//   todayClientCount?: number;
// }) {
//   const agents = opts.agents ?? makeAgents(3);
//   const strategy = opts.strategy ?? 'ROUND_ROBIN';
//   const todayCount = opts.todayClientCount ?? 0;

//   const updatedLastAssigned: Record<string, Date> = {};

//   return {
//     tenant: {
//       findUnique: jest.fn().mockResolvedValue({ leadAssignmentStrategy: strategy }),
//     },
//     user: {
//       findMany: jest.fn().mockImplementation(() => {
//         // Return agents with up-to-date lastAssignedAt from updates
//         return Promise.resolve(agents.map(a => ({
//           ...a,
//           lastAssignedAt: updatedLastAssigned[a.id] ?? a.lastAssignedAt,
//         })));
//       }),
//       update: jest.fn().mockImplementation(({ where, data }) => {
//         updatedLastAssigned[where.id] = data.lastAssignedAt;
//         return Promise.resolve({});
//       }),
//     },
//     client: {
//       count: jest.fn().mockResolvedValue(todayCount),
//       update: jest.fn().mockResolvedValue({}),
//       findFirst: jest.fn().mockResolvedValue(null),
//     },
//     clientTimeline: {
//       create: jest.fn().mockResolvedValue({}),
//     },
//   };
// }

// function buildService(prisma: any): RoundRobinService {
//   const notifications = { create: jest.fn().mockResolvedValue({}) } as any;
//   const audit = { log: jest.fn() } as any;
//   const svc = new RoundRobinService(prisma as any, notifications, audit);
//   return svc;
// }

// // ─── Tests ────────────────────────────────────────────────────

// describe('RoundRobinService', () => {

//   describe('getNextAgent() — basic rotation', () => {
//     it('agent1 oladi birinchi leadni', async () => {
//       const prisma = buildPrisma({});
//       const svc = buildService(prisma);
//       const result = await svc.getNextAgent('tenant-1');
//       expect(result).toBe('agent-1');
//     });

//     it('toʻliq rotation: lead1→ag1, lead2→ag2, lead3→ag3, lead4→ag1', async () => {
//       const prisma = buildPrisma({});
//       const svc = buildService(prisma);

//       const r1 = await svc.getNextAgent('tenant-1');
//       const r2 = await svc.getNextAgent('tenant-1');
//       const r3 = await svc.getNextAgent('tenant-1');
//       const r4 = await svc.getNextAgent('tenant-1'); // back to first

//       expect(r1).toBe('agent-1');
//       expect(r2).toBe('agent-2');
//       expect(r3).toBe('agent-3');
//       expect(r4).toBe('agent-1');
//     });

//     it('bitta agent bo'lsa ham to'g'ri ishlaydi', async () => {
//       const prisma = buildPrisma({ agents: makeAgents(1) });
//       const svc = buildService(prisma);

//       const r1 = await svc.getNextAgent('tenant-1');
//       const r2 = await svc.getNextAgent('tenant-1');
//       expect(r1).toBe('agent-1');
//       expect(r2).toBe('agent-1');
//     });

//     it('agents bo'lmasa null qaytaradi', async () => {
//       const prisma = buildPrisma({ agents: [] });
//       const svc = buildService(prisma);
//       const result = await svc.getNextAgent('tenant-1');
//       expect(result).toBeNull();
//     });
//   });

//   describe('assignToNewLead() — strategiya tekshirish', () => {
//     it('ROUND_ROBIN strategiyasida agent qaytaradi', async () => {
//       const prisma = buildPrisma({ strategy: 'ROUND_ROBIN' });
//       const svc = buildService(prisma);
//       const result = await svc.assignToNewLead('tenant-1');
//       expect(result).toBe('agent-1');
//     });

//     it('MANUAL strategiyasida null qaytaradi', async () => {
//       const prisma = buildPrisma({ strategy: 'MANUAL' });
//       const svc = buildService(prisma);
//       const result = await svc.assignToNewLead('tenant-1');
//       expect(result).toBeNull();
//     });

//     it('tenant topilmasa null qaytaradi', async () => {
//       const prisma = buildPrisma({});
//       prisma.tenant.findUnique = jest.fn().mockResolvedValue(null);
//       const svc = buildService(prisma);
//       const result = await svc.assignToNewLead('non-existent');
//       expect(result).toBeNull();
//     });
//   });

//   describe('isPausedFromAssignment — paused agentlar o'tkazib yuboriladi', () => {
//     it('paused agentlarni o'tkazib keyingisini oladi', async () => {
//       const agents = makeAgents(3);
//       agents[0].isPausedFromAssignment = true; // agent-1 paused

//       const prisma = buildPrisma({ agents });
//       // findMany faqat pause=false agentlarni qaytarsin
//       prisma.user.findMany = jest.fn().mockResolvedValue(
//         agents.filter(a => !a.isPausedFromAssignment)
//       );

//       const svc = buildService(prisma);
//       const r1 = await svc.getNextAgent('tenant-1');
//       const r2 = await svc.getNextAgent('tenant-1');

//       expect(r1).toBe('agent-2');
//       expect(r2).toBe('agent-3');
//     });

//     it('hamma agent paused bo'lsa null qaytaradi', async () => {
//       const agents = makeAgents(2);
//       agents[0].isPausedFromAssignment = true;
//       agents[1].isPausedFromAssignment = true;

//       const prisma = buildPrisma({ agents });
//       prisma.user.findMany = jest.fn().mockResolvedValue([]);

//       const svc = buildService(prisma);
//       const result = await svc.getNextAgent('tenant-1');
//       expect(result).toBeNull();
//     });
//   });

//   describe('dailyLeadLimit — kunlik limit', () => {
//     it('limitga yetgan agent o'tkazib yuboriladi', async () => {
//       const agents = makeAgents(3);
//       agents[0].dailyLeadLimit = 5; // agent-1 limitga yetdi

//       const prisma = buildPrisma({ agents, todayClientCount: 5 });
//       const svc = buildService(prisma);

//       // agent-1 limitga yetdi, agent-2 olishi kerak
//       const result = await svc.getNextAgent('tenant-1');
//       expect(result).toBe('agent-2');
//     });

//     it('limit=0 cheksiz deb hisoblanadi', async () => {
//       const agents = makeAgents(1);
//       agents[0].dailyLeadLimit = 0;

//       const prisma = buildPrisma({ agents, todayClientCount: 1000 });
//       const svc = buildService(prisma);

//       const result = await svc.getNextAgent('tenant-1');
//       expect(result).toBe('agent-1');
//     });
//   });

//   describe('assignLeadToAgent() — to'liq tayinlash oqimi', () => {
//     it('clientni yangilaydi va agent ID qaytaradi', async () => {
//       const prisma = buildPrisma({ strategy: 'ROUND_ROBIN' });
//       const svc = buildService(prisma);

//       const agentId = await svc.assignLeadToAgent({
//         tenantId: 'tenant-1',
//         clientId: 'client-1',
//         clientName: 'Aziz Aliyev',
//         source: 'WEBSITE',
//       });

//       expect(agentId).toBe('agent-1');
//       expect(prisma.client.update).toHaveBeenCalledWith({
//         where: { id: 'client-1' },
//         data: { assignedAgentId: 'agent-1' },
//       });
//     });

//     it('MANUAL strategiyasida clientni yangilamaydi', async () => {
//       const prisma = buildPrisma({ strategy: 'MANUAL' });
//       const svc = buildService(prisma);

//       const agentId = await svc.assignLeadToAgent({
//         tenantId: 'tenant-1',
//         clientId: 'client-1',
//         clientName: 'Aziz Aliyev',
//       });

//       expect(agentId).toBeNull();
//       expect(prisma.client.update).not.toHaveBeenCalled();
//     });
//   });

//   describe('assignUnassigned() — admin qayta taqsimlash', () => {
//     it('tayinlanmagan leadlarni agentlarga taqsimlaydi', async () => {
//       const unassigned = [
//         { id: 'c1', fullName: 'Client 1', source: 'WEB' },
//         { id: 'c2', fullName: 'Client 2', source: 'WEB' },
//       ];

//       const prisma = buildPrisma({});
//       prisma.client.findMany = jest.fn().mockResolvedValue(unassigned);
//       prisma.client.update = jest.fn().mockResolvedValue({});

//       const svc = buildService(prisma);
//       const result = await svc.assignUnassigned('tenant-1');

//       expect(result.assigned).toBe(2);
//       expect(result.skipped).toBe(0);
//       expect(prisma.client.update).toHaveBeenCalledTimes(2);
//     });
//   });
// });
