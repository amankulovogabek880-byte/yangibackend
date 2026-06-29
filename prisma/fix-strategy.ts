/**
 * fix-strategy.ts
 * 
 * Barcha mavjud tenantlar uchun leadAssignmentStrategy ni ROUND_ROBIN ga o'tkazadi.
 * Bir martalik ishlatish uchun:
 *   npx ts-node prisma/fix-strategy.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.tenant.updateMany({
    where: { leadAssignmentStrategy: 'MANUAL' },
    data: { leadAssignmentStrategy: 'ROUND_ROBIN' },
  });
  console.log(`✅ ${result.count} ta tenant MANUAL → ROUND_ROBIN ga o'tkazildi`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
