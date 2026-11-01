import { Global, Module } from '@nestjs/common';
import { AdminAccessGate } from './admin-access';
import { AdminGuard, MemberGuard, RolesGuard } from './guards';
import { TokenService } from './token.service';

@Global()
@Module({
  providers: [TokenService, AdminAccessGate, MemberGuard, AdminGuard, RolesGuard],
  exports: [TokenService, AdminAccessGate, MemberGuard, AdminGuard, RolesGuard],
})
export class AuthModule {}
