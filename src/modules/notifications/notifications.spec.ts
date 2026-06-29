// Notifications service logic testlari
describe('Notification types', () => {
  const TYPES = [
    'LEAD_ASSIGNED', 'LEAD_NEW', 'NEW_MESSAGE', 'BOOKING_CREATED',
    'BOOKING_UPDATED', 'PAYMENT_RECEIVED', 'TASK_DUE', 'FOLLOW_UP_DUE',
    'SECURITY_NEW_LOGIN', 'SECURITY_PASSWORD_CHANGED', 'CLIENT_ASSIGNED',
  ];

  it('barcha tiplar string', () => {
    TYPES.forEach(t => expect(typeof t).toBe('string'));
  });

  it('tiplar unique', () => {
    expect(new Set(TYPES).size).toBe(TYPES.length);
  });

  it('LEAD_ASSIGNED mavjud', () => {
    expect(TYPES).toContain('LEAD_ASSIGNED');
  });
});

describe('Notification body formatting', () => {
  function truncate(text: string, max = 100): string {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  it('qisqa matn o\'zgarmaydi', () => {
    expect(truncate('Salom')).toBe('Salom');
  });
  it('uzun matn qisqartiriladi', () => {
    const long = 'A'.repeat(150);
    expect(truncate(long, 100).length).toBe(103); // 100 + '...'
  });
  it('100 belgi chegara', () => {
    const text = 'B'.repeat(100);
    expect(truncate(text)).toBe(text);
  });
});

describe('Notification priority', () => {
  function getPriority(type: string): 'high' | 'normal' | 'low' {
    const high = ['SECURITY_NEW_LOGIN', 'SECURITY_PASSWORD_CHANGED', 'SECURITY_SUSPICIOUS_ACTIVITY'];
    const low = ['TASK_DUE', 'FOLLOW_UP_DUE'];
    if (high.includes(type)) return 'high';
    if (low.includes(type)) return 'low';
    return 'normal';
  }

  it('xavfsizlik - high', () => expect(getPriority('SECURITY_NEW_LOGIN')).toBe('high'));
  it('yangi lead - normal', () => expect(getPriority('LEAD_NEW')).toBe('normal'));
  it('vazifa eslatma - low', () => expect(getPriority('TASK_DUE')).toBe('low'));
});
