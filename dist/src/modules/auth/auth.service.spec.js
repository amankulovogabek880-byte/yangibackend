"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const jwt_1 = require("@nestjs/jwt");
const auth_service_1 = require("./auth.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const encryption_service_1 = require("../../common/encryption/encryption.service");
const email_service_1 = require("../email/email.service");
const notifications_service_1 = require("../notifications/notifications.service");
const common_1 = require("@nestjs/common");
const mockPrisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    },
    userSession: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    loginAttempt: {
        create: jest.fn(),
        findMany: jest.fn(),
    },
};
const mockJwt = {
    signAsync: jest.fn().mockResolvedValue('mock-token'),
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-id' }),
};
const mockEncryption = {
    encrypt: jest.fn((v) => `enc:${v}`),
    decrypt: jest.fn((v) => v?.replace('enc:', '')),
};
const mockEmail = {
    sendFailedLoginAlert: jest.fn().mockResolvedValue(undefined),
    sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
    sendLoginAlert: jest.fn().mockResolvedValue(undefined),
};
const mockNotifications = {
    create: jest.fn().mockResolvedValue(undefined),
};
describe('AuthService', () => {
    let service;
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                auth_service_1.AuthService,
                { provide: prisma_service_1.PrismaService, useValue: mockPrisma },
                { provide: jwt_1.JwtService, useValue: mockJwt },
                { provide: encryption_service_1.EncryptionService, useValue: mockEncryption },
                { provide: email_service_1.EmailService, useValue: mockEmail },
                { provide: notifications_service_1.NotificationsService, useValue: mockNotifications },
            ],
        }).compile();
        service = module.get(auth_service_1.AuthService);
        jest.clearAllMocks();
    });
    describe('hashPassword & verifyPassword', () => {
        it('parolni hash qiladi va tekshiradi', async () => {
            const password = 'TestPass123!';
            const hash = await (0, auth_service_1.hashPassword)(password);
            expect(hash).not.toBe(password);
            expect(hash.startsWith('$argon2')).toBe(true);
            const ok = await (0, auth_service_1.verifyPassword)(hash, password);
            expect(ok).toBe(true);
        });
        it('noto\'g\'ri parolni rad etadi', async () => {
            const hash = await (0, auth_service_1.hashPassword)('correct-password');
            const ok = await (0, auth_service_1.verifyPassword)(hash, 'wrong-password');
            expect(ok).toBe(false);
        });
    });
    describe('login', () => {
        const mockUser = {
            id: 'user-1',
            email: 'test@test.com',
            name: 'Test User',
            role: 'AGENT',
            tenantId: 'tenant-1',
            status: 'ACTIVE',
            passwordHash: '',
            twoFactorEnabled: false,
            failedLoginCount: 0,
            lockedUntil: null,
            tenant: { status: 'ACTIVE', name: 'Test', slug: 'test', plan: 'STARTER', brandColor: null },
        };
        beforeEach(async () => {
            mockUser.passwordHash = await (0, auth_service_1.hashPassword)('ValidPass123!');
        });
        it('to\'g\'ri credentials bilan kiradi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.userSession.create.mockResolvedValue({ id: 'session-1' });
            mockPrisma.userSession.findMany.mockResolvedValue([]);
            mockPrisma.user.update.mockResolvedValue(mockUser);
            mockPrisma.loginAttempt.create.mockResolvedValue({});
            const result = await service.login('test@test.com', 'ValidPass123!', undefined);
            expect(result).toHaveProperty('accessToken');
            expect(result).toHaveProperty('refreshToken');
            expect(result.user.email).toBe('test@test.com');
        });
        it('mavjud bo\'lmagan email bilan kirish rad etiladi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(null);
            mockPrisma.loginAttempt.create.mockResolvedValue({});
            await expect(service.login('noone@test.com', 'anypass', undefined)).rejects.toThrow(common_1.UnauthorizedException);
        });
        it('noto\'g\'ri parol bilan kirish rad etiladi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.loginAttempt.create.mockResolvedValue({});
            mockPrisma.user.update.mockResolvedValue(mockUser);
            await expect(service.login('test@test.com', 'WrongPass123!', undefined)).rejects.toThrow(common_1.UnauthorizedException);
        });
        it('INACTIVE foydalanuvchi kirolmaydi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, status: 'INACTIVE' });
            mockPrisma.loginAttempt.create.mockResolvedValue({});
            await expect(service.login('test@test.com', 'ValidPass123!', undefined)).rejects.toThrow(common_1.ForbiddenException);
        });
        it('bloklangan foydalanuvchi kirolmaydi', async () => {
            const lockedUser = {
                ...mockUser,
                lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
            };
            mockPrisma.user.findUnique.mockResolvedValue(lockedUser);
            mockPrisma.loginAttempt.create.mockResolvedValue({});
            await expect(service.login('test@test.com', 'ValidPass123!', undefined)).rejects.toThrow(common_1.ForbiddenException);
        });
        it('email formati noto\'g\'ri bo\'lsa xato beradi', async () => {
            await expect(service.login('not-an-email', 'ValidPass123!', undefined)).rejects.toThrow(common_1.UnauthorizedException);
        });
    });
    describe('createUser', () => {
        it('yangi agent yaratadi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(null);
            mockPrisma.user.create.mockResolvedValue({
                id: 'new-user', email: 'agent@test.com', name: 'Agent', role: 'AGENT',
                tenantId: 'tenant-1', status: 'ACTIVE', twoFactorEnabled: false,
            });
            const result = await service.createUser('tenant-1', {
                email: 'agent@test.com',
                password: 'Agent1234!',
                name: 'Agent',
                role: 'AGENT',
            });
            expect(result.email).toBe('agent@test.com');
        });
        it('mavjud email bilan yaratish rad etiladi', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ id: 'exists' });
            await expect(service.createUser('tenant-1', {
                email: 'exists@test.com',
                password: 'Agent1234!',
                name: 'Agent',
                role: 'AGENT',
            })).rejects.toThrow();
        });
        it('TENANT_ADMIN rolini yarata olmaydi', async () => {
            await expect(service.createUser('tenant-1', {
                email: 'admin@test.com',
                password: 'Admin1234!',
                name: 'Admin',
                role: 'TENANT_ADMIN',
            })).rejects.toThrow(common_1.BadRequestException);
        });
    });
});
//# sourceMappingURL=auth.service.spec.js.map