import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  type ForwardingGuide,
  type NumberAccepted,
  type PhoneNumberResponse,
  type PhonePlanResponse,
  buyNumberRequest,
  forwardingGuideQuery,
  importNumberRequest,
  phonePlanRequest,
  sipVerifyRequest,
  updateNumberRequest,
  uuid,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { NumbersService } from './numbers.service';
import { PhonePlansService } from './phone-plans.service';
import { SipVerificationService } from './sip-verification.service';

/**
 * W6 — the agent's number choice (§16 `PUT /agents/:id/phone-plan`). Editor and above;
 * the activation job executes it after payment (§13.8).
 */
@Controller('agents/:id/phone-plan')
export class PhonePlanController {
  constructor(private readonly plans: PhonePlansService) {}

  @Put()
  @Roles('owner', 'admin', 'editor')
  put(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<PhonePlanResponse> {
    return this.plans.put(ctx, idOf(id, 'Agent'), phonePlanRequest.parse(body));
  }

  @Get()
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<PhonePlanResponse | null> {
    return this.plans.get(ctx, idOf(id, 'Agent'));
  }
}

/**
 * D4 Numbers (§16). The §6.1 matrix: buying, importing and releasing a number moves
 * money, so owner/admin; routing edits are editor and above; every role reads.
 */
@Controller('numbers')
export class NumbersController {
  constructor(
    private readonly numbers: NumbersService,
    private readonly sip: SipVerificationService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext): Promise<PhoneNumberResponse[]> {
    return this.numbers.list(ctx);
  }

  /** Declared before `:id` so the literal path wins. */
  @Get('forwarding-guide')
  guide(@Ctx() _ctx: WorkspaceContext, @Query() query: Record<string, unknown>): ForwardingGuide {
    const { carrier } = forwardingGuideQuery.parse(query);
    const destination = typeof query.destination === 'string' ? query.destination : null;
    return this.numbers.guide(carrier, destination);
  }

  @Post('buy')
  @HttpCode(202)
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  buy(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<NumberAccepted> {
    return this.numbers.buy(ctx, buyNumberRequest.parse(body));
  }

  @Post('import')
  @HttpCode(202)
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  import(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<NumberAccepted> {
    return this.numbers.import(ctx, importNumberRequest.parse(body));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<PhoneNumberResponse> {
    return this.numbers.get(ctx, idOf(id, 'Phone number'));
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'editor')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<PhoneNumberResponse> {
    return this.numbers.update(ctx, idOf(id, 'Phone number'), updateNumberRequest.parse(body));
  }

  /**
   * D16: re-check an imported number's SIP trunk, optionally with new credentials. Owner
   * and admin, like importing one: it can replace the stored password. Answers the number,
   * whose `sip.verification` carries the outcome.
   */
  @Post(':id/sip/verify')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  async verifySip(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<PhoneNumberResponse> {
    const numberId = idOf(id, 'Phone number');
    await this.sip.verify(ctx, numberId, sipVerifyRequest.parse(body ?? {}));
    return this.numbers.get(ctx, numberId);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ released: boolean }> {
    return this.numbers.remove(ctx, idOf(id, 'Phone number'));
  }
}

function idOf(value: string, what: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound(what);
  return parsed.data;
}
