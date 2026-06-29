"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkipAudit = exports.Public = exports.Roles = exports.CurrentUser = void 0;
const common_1 = require("@nestjs/common");
exports.CurrentUser = (0, common_1.createParamDecorator)((_, ctx) => ctx.switchToHttp().getRequest().user);
const Roles = (...roles) => (0, common_1.SetMetadata)('roles', roles);
exports.Roles = Roles;
const Public = () => (0, common_1.SetMetadata)('isPublic', true);
exports.Public = Public;
const SkipAudit = () => (0, common_1.SetMetadata)('skipAudit', true);
exports.SkipAudit = SkipAudit;
//# sourceMappingURL=index.js.map