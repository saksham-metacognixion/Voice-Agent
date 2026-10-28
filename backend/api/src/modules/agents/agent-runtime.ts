import type { AgentSettings, FlagsResponse } from '@portal/schemas';
import { recordingNotice } from '../prompting/recording-notice';

/** The workspace's privacy settings a sync reads (D6 Data & privacy, QA-081). */
export interface PrivacyColumns {
  recordingNotice: boolean;
  recordingNoticeText: string | null;
}

export interface RuntimeAddOns {
  denoise: boolean;
  piiRemoval: boolean;
  recordingNotice: string | null;
}

/**
 * What a version's add-ons become on the platform, decided at every sync (QA-079,
 * QA-081). Both callers of `AgentRetellService.syncDraft` — publish and the draft sync —
 * go through this, so a test call and the live agent can never disagree.
 *
 * The plan gate is applied here as well as on the way in (`PATCH /agents/:id/draft`
 * refuses to turn either on without it): a workspace whose plan lost the gate — a
 * downgrade at the 12-month mark, a staff override removed — has the add-on sent *off*
 * at the agent's next sync, while the version keeps the customer's choice for the day
 * the plan comes back.
 */
export function runtimeAddOns(
  settings: AgentSettings,
  gates: FlagsResponse['gates'],
  privacy: PrivacyColumns,
): RuntimeAddOns {
  return {
    denoise: settings.denoise && gates.denoise === true,
    piiRemoval: settings.pii_removal && gates.pii_removal === true,
    recordingNotice: recordingNotice({
      recording: settings.recording_enabled,
      enabled: privacy.recordingNotice,
      text: privacy.recordingNoticeText,
      language: settings.primary_language,
    }),
  };
}
