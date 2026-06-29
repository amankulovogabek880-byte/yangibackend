"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../../common/utils/helpers");
const PIPELINE_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CONFIRMED', 'LOST'];
const LEAD_SOURCES = ['INSTAGRAM', 'TELEGRAM', 'WHATSAPP', 'WEBSITE', 'REFERRAL', 'CALL', 'WALK_IN', 'OTHER'];
describe('Pipeline stage flow', () => {
    const STAGE_INDEX = {};
    PIPELINE_STAGES.forEach((s, i) => STAGE_INDEX[s] = i);
    function canAdvance(from, to) {
        if (to === 'LOST')
            return true;
        return STAGE_INDEX[to] === STAGE_INDEX[from] + 1;
    }
    it('NEW -> CONTACTED mumkin', () => expect(canAdvance('NEW', 'CONTACTED')).toBe(true));
    it('NEW -> CONFIRMED mumkin emas (skip)', () => expect(canAdvance('NEW', 'CONFIRMED')).toBe(false));
    it('istalgan bosqichdan LOST mumkin', () => {
        PIPELINE_STAGES.forEach(s => expect(canAdvance(s, 'LOST')).toBe(true));
    });
    it('CONFIRMED -> LOST mumkin', () => expect(canAdvance('CONFIRMED', 'LOST')).toBe(true));
});
describe('Lead source validation', () => {
    it('INSTAGRAM valid', () => expect((0, helpers_1.safeEnum)('INSTAGRAM', LEAD_SOURCES, 'OTHER')).toBe('INSTAGRAM'));
    it('WHATSAPP valid', () => expect((0, helpers_1.safeEnum)('WHATSAPP', LEAD_SOURCES, 'OTHER')).toBe('WHATSAPP'));
    it('TELEGRAM valid', () => expect((0, helpers_1.safeEnum)('TELEGRAM', LEAD_SOURCES, 'OTHER')).toBe('TELEGRAM'));
    it('UNKNOWN -> OTHER', () => expect((0, helpers_1.safeEnum)('UNKNOWN', LEAD_SOURCES, 'OTHER')).toBe('OTHER'));
    it('undefined -> OTHER', () => expect((0, helpers_1.safeEnum)(undefined, LEAD_SOURCES, 'OTHER')).toBe('OTHER'));
});
describe('Round-robin assignment', () => {
    function roundRobin(agents, lastIndex) {
        if (!agents.length)
            throw new Error('Agentlar yo\'q');
        const nextIndex = (lastIndex + 1) % agents.length;
        return { agentId: agents[nextIndex], nextIndex };
    }
    const agents = ['agent-1', 'agent-2', 'agent-3'];
    it('birinchi agent tayinlanadi', () => {
        const { agentId } = roundRobin(agents, -1);
        expect(agentId).toBe('agent-1');
    });
    it('navbat bilan o\'tadi', () => {
        let idx = -1;
        const assigned = [];
        for (let i = 0; i < 6; i++) {
            const r = roundRobin(agents, idx);
            assigned.push(r.agentId);
            idx = r.nextIndex;
        }
        expect(assigned[0]).toBe('agent-1');
        expect(assigned[1]).toBe('agent-2');
        expect(assigned[2]).toBe('agent-3');
        expect(assigned[3]).toBe('agent-1');
    });
    it('bir agent bo\'lsa ham ishlaydi', () => {
        const { agentId } = roundRobin(['solo-agent'], 0);
        expect(agentId).toBe('solo-agent');
    });
    it('bo\'sh array xato beradi', () => {
        expect(() => roundRobin([], 0)).toThrow();
    });
});
describe('Lead score thresholds', () => {
    function getLeadLabel(score) {
        if (score >= 80)
            return 'HOT';
        if (score >= 60)
            return 'WARM';
        if (score >= 40)
            return 'COOL';
        return 'COLD';
    }
    it('90 - HOT', () => expect(getLeadLabel(90)).toBe('HOT'));
    it('70 - WARM', () => expect(getLeadLabel(70)).toBe('WARM'));
    it('50 - COOL', () => expect(getLeadLabel(50)).toBe('COOL'));
    it('20 - COLD', () => expect(getLeadLabel(20)).toBe('COLD'));
    it('80 - HOT (chegara)', () => expect(getLeadLabel(80)).toBe('HOT'));
    it('79 - WARM', () => expect(getLeadLabel(79)).toBe('WARM'));
});
//# sourceMappingURL=leads.spec.js.map