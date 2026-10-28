import { Module } from '@nestjs/common';
import { CallsModule } from '../calls';
import { WalletModule } from '../wallet';
import { DataRequestsController } from './data-requests.controller';
import { DataRequestsService } from './data-requests.service';
import { WorkspaceExportService } from './workspace-export.service';

/**
 * D6 Data & privacy (QA-081, §17): the customer's "export all data" and "delete workspace"
 * on `data_requests`. Sits above `calls` and `wallet` (the export reuses their CSV
 * streams) and borrows the support module's ticket insert as a plain function; nothing
 * imports it. Carrying a deletion out is staff's §17 anonymisation job — not here.
 */
@Module({
  imports: [CallsModule, WalletModule],
  controllers: [DataRequestsController],
  providers: [DataRequestsService, WorkspaceExportService],
})
export class DataRequestsModule {}
