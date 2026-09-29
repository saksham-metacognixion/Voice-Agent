# 0024 — What the agent knows comes after payment

Date: 29 Sep 2026. Status: accepted. Amends the W1–W7 order of spec §8 (W4 is moved, not
removed). Builds on ADR 0013 (knowledge sources, activation), ADR 0017 (gating), ADR 0020
(the restaurant menu as a knowledge role), ADR 0023 (documents in the brief). Spec: §5.2,
§8 W4, §11, D3.

## Context

W4 sat between the voice (W3) and the test call (W5). Every workspace that reaches W4 in
the wizard is on the trial, and a knowledge source needs the `knowledge_base` plan gate,
which the trial never has (§5.2: Starter includes none either). So W4 only ever showed a
locked form: "Included from a bigger pack… Skip for now and come back after you choose a
pack in the last step". Every customer met a paywall two steps before they had heard
their agent, and the step could do nothing for them. Saksham raised it on 29 Sep 2026 from
a restaurant agent on the trial.

Since ADR 0023 the pre-payment answer to "where does my menu go" is W2's documents,
which have no plan gate. That leaves W4 useful only after a purchase.

## Decision

1. **The pre-payment wizard is W1 → W2 → W3 → W5 → W6 → W7.** W3's Continue advances
   `onboarding_step` to 5 and opens W5. The numbering is kept: `mark_live` writes 7, the
   API accepts 1–7 and the SA1 funnel counts on the numbers, so 4 is simply unused.
   `stepPath()` resolves a step to that step's page or the next one that exists, so a
   workspace an older build left on 4 resumes on W5. The funnel no longer draws a
   "Knowledge (W4)" bar, which would only have counted W3 completions.
2. **Knowledge is the first page after go-live.** When the activation is `live`, W7 sends
   the customer to `/onboarding/knowledge/` (behind `LiveGuard`, as `/onboarding/live` is),
   and its Continue / "Skip for now" goes on to `/onboarding/live/`. The stepper draws it
   as the last dot, after "Go live", linked only once onboarding is complete. It is still
   gated by the pack that was bought: a Starter customer sees the locked form naming the
   pack that unlocks it, and the D3 Knowledge tab is where they come back.
3. **A source added to a live agent reaches the phone by itself.** The platform versions
   the LLM with the agent (ADR 0003 §7), so a knowledge base created after the publish
   is invisible to the live agent until the next publish. Now that knowledge usually
   *is* added after the publish, that caveat could not stay the customer's problem. The
   `knowledge-sync` job that attaches a base to an agent with a `published_version`
   marks the source `sync_json.republish = true`; once the source is `ready` it calls
   `AgentPublishService.publish(…, published_version, {refresh: true})`, which skips the
   "already live" short-circuit and nothing else: same lint, lease, branch-first sync and
   persist. Our version number is unchanged; `retell_agent_version` moves to the new
   platform version, whose LLM carries the base. The republish runs outside the sync's
   `try`, so its failure is never read as a failed read (and never clears
   `retell_kb_id` on a 404). The mark survives a throw, and the job's retry finds the row
   `ready` with the mark still set and republishes again. The actor is the member who
   added the source (`sync_json.requested_by`), else the owner. A later source goes into
   the same base, which the live LLM already references, and publishes nothing.

4. **A photo is a knowledge source too.** The menu slot and the "Add a source" file
   field accept JPEG, PNG and WebP. The platform ingests documents, not images, so the
   portal shrinks the photo, reads it into text through the same
   `POST /agents/:id/documents/extract` W2 uses (ADR 0023), and adds a `text` source with
   that text. A replace reads the new photo before it removes the old menu, so an
   unreadable photo never costs the customer their current menu.

## Alternatives considered

- **Keep W4 before payment, unlocked for the trial.** A knowledge base costs a platform
  object, a sync job and a monthly allowance (§5.3). Giving one to every trial workspace
  is a pricing decision, not a UX one, and W2's documents already cover the trial.
- **Renumber the steps 1–6 and make knowledge 7.** That would touch the API schema, the
  activation job, the funnel and every workspace that is part-way through the wizard, for
  no visible difference.
- **A "Publish to apply" button on the knowledge page.** It would be a second publish
  the customer has to understand. With no new version of ours to publish it would also
  need a fork, and every knowledge edit would add a row to the version history.

## Consequences

- W7 no longer lands on the live screen directly. The customer sees knowledge first and
  their number one click later.
- The last-source delete still deletes the platform base while the live LLM references
  it. That is unchanged from ADR 0013 and is left for a follow-up: detaching needs an
  explicit empty `knowledge_base_ids` on the LLM, which the gateway does not send today.
- `e2e:wizard` asserts W3 → W5 and the knowledge page's `LiveGuard`. `e2e:restaurant`
  still exercises the menu on the pre-payment W4 and needs its W4 section moved to the
  post-live page or D3.
- `test/d6-knowledge.e2e.test.ts` covers the republish: one platform publish when a live
  agent gets its base, the same version of ours, the LLM update carrying the base, and
  no publish for a second source.
