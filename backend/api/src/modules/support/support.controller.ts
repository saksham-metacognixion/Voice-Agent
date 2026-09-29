import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  type Page,
  type SupportTicketResponse,
  createSupportTicketRequest,
  supportTicketMessageRequest,
  supportTicketsQuery,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { SupportService } from './support.service';

/**
 * D7 Help "Contact support" and "My tickets" (spec §16 additions, D13). Every member reads
 * the workspace's tickets; opening one and replying is editor and above — a viewer looks,
 * an editor writes, the same line every other customer write draws.
 */
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @Roles('owner', 'admin', 'editor')
  create(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<SupportTicketResponse> {
    return this.support.create(ctx, createSupportTicketRequest.parse(body));
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<Page<SupportTicketResponse>> {
    return this.support.list(ctx, supportTicketsQuery.parse(query));
  }

  @Post(':id/messages')
  @Roles('owner', 'admin', 'editor')
  reply(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<SupportTicketResponse> {
    return this.support.reply(ctx, ticketParam(id), supportTicketMessageRequest.parse(body));
  }
}

/** A ticket number: a positive integer, else 404. */
function ticketParam(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) throw AppError.notFound('Ticket');
  return Number(raw);
}
