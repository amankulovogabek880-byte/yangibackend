"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
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
//# sourceMappingURL=fix-strategy.js.map