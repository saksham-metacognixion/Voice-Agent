/*
 * §5.3 number rental, the pure rules. Shared by the hourly `number-rental` sweep
 * (NumberRentalService) and the first month charged at activation
 * (NumberProvisioningService.bind, ADR 0035), so one decision governs both.
 */

/**
 * Charge, or mark overdue? The one rule the wallet asks recurring charges to obey
 * (WalletService.debit): never debit past the grace overdraft — take the §5.3 "release
 * after N days at zero balance" path instead.
 */
export function decideRental(input: { balance: number; rental: number; grace: number }): 'charge' | 'overdue' {
  if (input.rental <= 0) return 'charge';
  return input.balance - input.rental >= -input.grace ? 'charge' : 'overdue';
}

export interface FirstMonthRow {
  type: string;
  status: string;
  rentalCredits: number;
  nextRentalAt: Date | null;
  lastRentalAt: Date | null;
}

/**
 * Does binding this number owe its first month (spec §13.8 step 2: "first month charged
 * now")? A bought number that has never been charged and is not yet answering — the
 * row `bind` is about to make `active`. A BYO SIP number costs nothing, a number that
 * was already active or paused has its anniversary, and a row with `last_rental_at` was
 * charged by an earlier attempt (the retry after a crash between the wallet commit and
 * the job's own bookkeeping).
 */
export function firstMonthRentalDue(row: FirstMonthRow): boolean {
  if (row.type === 'custom_sip' || row.rentalCredits <= 0) return false;
  if (row.status === 'active' || row.status === 'paused') return false;
  return row.lastRentalAt === null && row.nextRentalAt === null;
}
