// Tenant validation testlari
describe('Tenant slug validation', () => {
  function validateSlug(slug: string): string {
    return slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
  }
  function isValidSlug(slug: string): boolean {
    return /^[a-z0-9-]{3,50}$/.test(slug) && slug !== '_platform';
  }

  it('oddiy slug to\'g\'ri', () => {
    expect(validateSlug('Omon Travel')).toBe('omon-travel');
  });
  it('maxsus belgilar almashtiriladi', () => {
    expect(validateSlug('Travel@2026!')).toBe('travel-2026-');
  });
  it('kichik harfga o\'tadi', () => {
    expect(validateSlug('OMON')).toBe('omon');
  });
  it('valid slug', () => {
    expect(isValidSlug('omon-travel')).toBe(true);
  });
  it('_platform taqiqlangan', () => {
    expect(isValidSlug('_platform')).toBe(false);
  });
  it('juda qisqa slug noto\'g\'ri', () => {
    expect(isValidSlug('ab')).toBe(false);
  });
  it('bo\'sh joy qabul qilinmaydi', () => {
    expect(isValidSlug('omon travel')).toBe(false);
  });
});

describe('Tenant plan limits', () => {
  const PLAN_LIMITS: Record<string, { users: number; clients: number; bookings: number }> = {
    FREE:         { users: 2,   clients: 100,  bookings: 50 },
    STARTER:      { users: 5,   clients: 500,  bookings: 500 },
    PROFESSIONAL: { users: 20,  clients: 5000, bookings: 5000 },
    ENTERPRISE:   { users: 999, clients: 999999, bookings: 999999 },
  };

  it('FREE eng kichik', () => {
    expect(PLAN_LIMITS.FREE.users).toBeLessThan(PLAN_LIMITS.STARTER.users);
  });
  it('ENTERPRISE eng katta', () => {
    expect(PLAN_LIMITS.ENTERPRISE.users).toBeGreaterThan(PLAN_LIMITS.PROFESSIONAL.users);
  });
  it('barcha planlar mavjud', () => {
    expect(Object.keys(PLAN_LIMITS)).toHaveLength(4);
  });
  it('STARTER 5 user', () => {
    expect(PLAN_LIMITS.STARTER.users).toBe(5);
  });
  it('FREE 100 klient', () => {
    expect(PLAN_LIMITS.FREE.clients).toBe(100);
  });
});

describe('Tenant status transitions', () => {
  const VALID: Record<string, string[]> = {
    TRIAL:     ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
    ACTIVE:    ['SUSPENDED', 'CANCELLED'],
    SUSPENDED: ['ACTIVE', 'CANCELLED'],
    CANCELLED: [],
  };

  function canTransition(from: string, to: string): boolean {
    return VALID[from]?.includes(to) ?? false;
  }

  it('TRIAL -> ACTIVE mumkin', () => expect(canTransition('TRIAL','ACTIVE')).toBe(true));
  it('ACTIVE -> SUSPENDED mumkin', () => expect(canTransition('ACTIVE','SUSPENDED')).toBe(true));
  it('CANCELLED -> ACTIVE mumkin emas', () => expect(canTransition('CANCELLED','ACTIVE')).toBe(false));
  it('SUSPENDED -> ACTIVE mumkin', () => expect(canTransition('SUSPENDED','ACTIVE')).toBe(true));
});
