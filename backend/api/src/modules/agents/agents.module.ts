import { Module } from '@nestjs/common';
import { RetellModule } from '../retell';
import { RuntimeCacheModule } from '../runtime-cache';
import { AgentPublishService } from './agent-publish.service';
import { AgentRetellService } from './agent-retell.service';
import { AgentStackService } from './agent-stack.service';
import { AgentsController, TemplatesController } from './agents.controller';
import { AgentsService } from './agents.service';
import { TemplatesService } from './templates.service';

/**
 * Spec §13.1 `agents` — the agent, its versions, the §9.2 template catalogue and the
 * §13.6 publish.
 *
 * `prompting` depends on this module and not the other way round: generation appends a
 * version through `AgentsService`, and the agent stack it reads (§9.3–§9.5 configuration)
 * lives here because publish needs it too. Keeping the arrow pointing one way is what
 * saves both modules from a `forwardRef`.
 */
@Module({
  imports: [RetellModule, RuntimeCacheModule],
  controllers: [AgentsController, TemplatesController],
  providers: [TemplatesService, AgentStackService, AgentsService, AgentRetellService, AgentPublishService],
  exports: [TemplatesService, AgentStackService, AgentsService, AgentRetellService, AgentPublishService],
})
export class AgentsModule {}
