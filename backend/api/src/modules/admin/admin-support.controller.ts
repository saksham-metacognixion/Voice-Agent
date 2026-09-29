import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  type AdminTicketDetail,
  type AdminTicketMacroResponse,
  type AdminTicketSummary,
  type CannedResponse,
  type DeletedResponse,
  type Page,
  adminCannedResponseRequest,
  adminCreateTicketRequest,
  adminTicketMacroRequest,
  adminTicketMessageRequest,
  adminTicketsQuery,
  adminUpdateTicketRequest,
  ticketMacro,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminSupportService } from './admin-support.service';

/*
 * Admin §4 SA4 (D13): tickets, the thread, the macros and the canned responses. Same rule
 * as the rest of `/admin/*`: parse, delegate, return. Ticket numbers are integers; anything
 * else in the path is a 404 before it reaches Postgres.
 */

/** Ticket writes: everyone but read-only. Finance is included because two of the macros move money. */
const TICKET_WRITE = ['super_admin', 'ops', 'support', 'finance'] as const;
/** Canned responses are the support desk's own text. */
const CANNED_WRITE = ['super_admin', 'ops', 'support'] as const;

@Controller('admin/tickets')
export class AdminTicketsController {
  constructor(private readonly support: AdminSupportService) {}

  @Get()
  list(
    @StaffCtx() staff: StaffContext,
    @Query() query: Record<string, unknown>,
  ): Promise<Page<AdminTicketSummary>> {
    return this.support.list(staff, adminTicketsQuery.parse(query));
  }

  @Post()
  @StaffRoles(...TICKET_WRITE)
  create(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    return this.support.create(staff, adminCreateTicketRequest.parse(body), request);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminTicketDetail> {
    return this.support.get(id);
  }

  @Patch(':id')
  @StaffRoles(...TICKET_WRITE)
  update(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    return this.support.update(staff, id, adminUpdateTicketRequest.parse(body), request);
  }

  @Post(':id/messages')
  @StaffRoles(...TICKET_WRITE)
  message(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTicketDetail> {
    return this.support.addMessage(staff, id, adminTicketMessageRequest.parse(body), request);
  }

  /** The macro's own roles are checked again inside the service (`rerun_activation` excludes finance). */
  @Post(':id/macros/:macro')
  @HttpCode(200)
  @StaffRoles(...TICKET_WRITE)
  macro(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Param('macro') macroRaw: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminTicketMacroResponse> {
    const macro = ticketMacro.safeParse(macroRaw);
    if (!macro.success) throw AppError.notFound('Macro');
    return this.support.macro(staff, id, macro.data, adminTicketMacroRequest.parse(body), request);
  }
}

@Controller('admin/canned-responses')
export class AdminCannedResponsesController {
  constructor(private readonly support: AdminSupportService) {}

  @Get()
  list(): Promise<CannedResponse[]> {
    return this.support.listCanned();
  }

  @Post()
  @StaffRoles(...CANNED_WRITE)
  create(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CannedResponse> {
    return this.support.createCanned(staff, adminCannedResponseRequest.parse(body), request);
  }

  @Delete(':id')
  @StaffRoles(...CANNED_WRITE)
  remove(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<DeletedResponse> {
    return this.support.deleteCanned(staff, id, request);
  }
}
