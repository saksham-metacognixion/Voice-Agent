/**
 * Check-and-reserve for `active:{ws}`, as one atomic Redis script.
 *
 * `decide()` reads the cache and then answers; between the read and the write, another
 * call for the same workspace can be doing exactly the same thing. Two authorisations
 * racing would each see the other's slot free and both be allowed — past the concurrency
 * cap, and each sized against credits the other is about to spend. Redis runs a script to
 * completion before anything else, so re-checking *inside* the write closes that window
 * without a lock and without a second round trip (ADR 0011 §1).
 *
 * The predicates are deliberately the same two `decide()` already evaluated:
 *   cap:      live calls (excluding this one) < concurrency_cap
 *   balance:  credits reserved by those calls < balance + grace
 * so a race loses on the same rule it would have lost on had it arrived a millisecond
 * later, and the caller can turn the refusal straight into the matching decline reason.
 *
 * It also sweeps expired fields while it is there, which is the only place they are
 * removed under contention.
 */
export const RESERVE_SCRIPT = `
local key        = KEYS[1]
local callId     = ARGV[1]
local credits    = ARGV[2]
local expiresAt  = tonumber(ARGV[3])
local now        = tonumber(ARGV[4])
local cap        = tonumber(ARGV[5])
local ceiling    = ARGV[6]
local ttl        = tonumber(ARGV[7])

local entries  = redis.call('HGETALL', key)
local live     = 0
local reserved = 0

for i = 1, #entries, 2 do
  local field = entries[i]
  local value = entries[i + 1]
  local sep   = string.find(value, '|', 1, true)
  local c     = sep and tonumber(string.sub(value, 1, sep - 1)) or nil
  local e     = sep and tonumber(string.sub(value, sep + 1)) or nil
  if c == nil or e == nil or e <= now then
    redis.call('HDEL', key, field)
  elseif field ~= callId then
    live     = live + 1
    reserved = reserved + c
  end
end

if cap >= 0 and live >= cap then return 'cap' end
if ceiling ~= '' and reserved >= tonumber(ceiling) then return 'balance' end

redis.call('HSET', key, callId, credits .. '|' .. ARGV[3])
redis.call('EXPIRE', key, ttl)
return 'ok'
`;

/** What the script answers. `skipped` is the caller's own value when it could not run it. */
export type ReserveResult = 'ok' | 'cap' | 'balance' | 'skipped';

export function isReserveResult(value: unknown): value is Exclude<ReserveResult, 'skipped'> {
  return value === 'ok' || value === 'cap' || value === 'balance';
}
