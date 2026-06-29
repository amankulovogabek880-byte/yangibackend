"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
describe('Task priority', () => {
    const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const PRIORITY_ORDER = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };
    it('URGENT eng yuqori', () => {
        expect(PRIORITY_ORDER.URGENT).toBeGreaterThan(PRIORITY_ORDER.HIGH);
    });
    it('barcha prioritetlar bor', () => {
        expect(PRIORITIES).toHaveLength(4);
    });
    it('LOW eng past', () => {
        expect(PRIORITY_ORDER.LOW).toBe(1);
    });
});
describe('Task status flow', () => {
    const TRANSITIONS = {
        TODO: ['IN_PROGRESS', 'CANCELLED'],
        IN_PROGRESS: ['DONE', 'TODO', 'CANCELLED'],
        DONE: ['TODO'],
        CANCELLED: ['TODO'],
    };
    function canMove(from, to) {
        return TRANSITIONS[from]?.includes(to) ?? false;
    }
    it('TODO -> IN_PROGRESS mumkin', () => expect(canMove('TODO', 'IN_PROGRESS')).toBe(true));
    it('IN_PROGRESS -> DONE mumkin', () => expect(canMove('IN_PROGRESS', 'DONE')).toBe(true));
    it('DONE -> IN_PROGRESS mumkin emas', () => expect(canMove('DONE', 'IN_PROGRESS')).toBe(false));
    it('CANCELLED -> TODO mumkin (restore)', () => expect(canMove('CANCELLED', 'TODO')).toBe(true));
});
describe('Task due date validation', () => {
    function isDueToday(dueDate) {
        const now = new Date();
        return dueDate.toDateString() === now.toDateString();
    }
    function isOverdue(dueDate) {
        return dueDate < new Date() && !isDueToday(dueDate);
    }
    it('bugungi sana - due today', () => {
        const today = new Date();
        expect(isDueToday(today)).toBe(true);
    });
    it('kechagi sana - overdue', () => {
        const yesterday = new Date(Date.now() - 86400000);
        expect(isOverdue(yesterday)).toBe(true);
    });
    it('ertangi sana - not overdue', () => {
        const tomorrow = new Date(Date.now() + 86400000);
        expect(isOverdue(tomorrow)).toBe(false);
    });
});
describe('Task reminder', () => {
    function minutesUntilDue(dueDate) {
        return Math.floor((dueDate.getTime() - Date.now()) / 60000);
    }
    it('1 soat keyin - 60 daqiqa', () => {
        const soon = new Date(Date.now() + 3600000);
        const mins = minutesUntilDue(soon);
        expect(mins).toBeGreaterThan(55);
        expect(mins).toBeLessThan(65);
    });
    it('o\'tgan - manfiy', () => {
        const past = new Date(Date.now() - 3600000);
        expect(minutesUntilDue(past)).toBeLessThan(0);
    });
});
//# sourceMappingURL=tasks.spec.js.map