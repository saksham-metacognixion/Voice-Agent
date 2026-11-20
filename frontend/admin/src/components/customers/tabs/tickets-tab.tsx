'use client';

import { useAdminListTickets, useApi } from '@portal/api-client';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pager } from '@/src/components/common/pager';
import { PermissionButton } from '@/src/components/common/permission-button';
import { QueryList } from '@/src/components/common/query-states';
import { TicketsTable } from '@/src/components/support/tickets-table';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { supportPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

const LIMIT = 25;

/** SA2 Customer 360 → Tickets: this workspace's tickets; opening one lands on the SA4 queue with the sheet open. */
export function TicketsTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const router = useRouter();
  const { can } = useStaff();
  const pager = useCursorPager();
  const list = useAdminListTickets(api, { tenant_id: customerId, cursor: pager.cursor, limit: LIMIT });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Link href={supportPath({ tenant_id: customerId })} className="text-sm text-primary hover:underline">
          Open in the support queue
        </Link>
        <PermissionButton size="sm" denied={can.supportTickets()} asChild>
          <Link href={supportPath({ new: customerId })}>
            <Plus /> New ticket
          </Link>
        </PermissionButton>
      </div>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No tickets', description: 'Nothing opened by this customer or for them yet.' }}>
        {(rows) => <TicketsTable rows={rows} showCustomer={false} onOpen={(id) => router.push(supportPath({ id }))} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </div>
  );
}
