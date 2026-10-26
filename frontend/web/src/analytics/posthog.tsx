'use client';

import posthog from 'posthog-js';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { config } from '../config';
import { workspaceStore } from '../workspace/store';

/**
 * PostHog (spec §12.1). Off when no key is set, so a dev box sends nothing. Identity is
 * the Auth0 `sub` — pseudonymous — and event properties are ids, step names and counts,
 * never brief text, email addresses or phone numbers. Page views are captured by hand on
 * route change (the static export has no server to count them).
 */
let initialised = false;

export function initAnalytics(): boolean {
  if (initialised) return true;
  if (!config.posthog.key || typeof window === 'undefined') return false;
  posthog.init(config.posthog.key, {
    api_host: config.posthog.host,
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: false,
    persistence: 'localStorage+cookie',
    person_profiles: 'identified_only',
  });
  posthog.register({ app: 'portal', app_env: config.appEnv });
  initialised = true;
  return true;
}

export type AnalyticsEvent =
  | 'signup_completed'
  | 'login_completed'
  | 'workspace_created'
  | 'workspace_switched'
  | 'invite_accepted'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'template_selected'
  | 'template_sample_played'
  | 'brief_field_saved'
  | 'brief_completed'
  | 'generate_clicked'
  | 'generation_started'
  | 'generation_completed'
  | 'generation_failed'
  | 'script_editor_opened'
  | 'voice_selected'
  | 'language_selected'
  // The portal's own language (en / ar), not the agent's.
  | 'language_changed'
  | 'voice_preview_played'
  // W4–W7 (D9). §12 names test_call_started/ended, pack_selected, checkout_completed.
  | 'knowledge_added'
  | 'knowledge_removed'
  | 'menu_uploaded'
  | 'menu_replaced'
  | 'menu_removed'
  | 'document_added'
  | 'document_removed'
  | 'test_call_started'
  | 'test_call_ended'
  | 'test_call_failed'
  | 'feedback_submitted'
  | 'feedback_applied'
  | 'feedback_failed'
  | 'phone_option_selected'
  | 'pack_selected'
  | 'checkout_returned'
  | 'checkout_confirmed'
  | 'checkout_cancelled'
  | 'checkout_completed'
  | 'agent_live'
  | 'onboarding_live_viewed'
  | 'forwarding_confirmed'
  | 'mfa_enrol_started'
  | 'password_reset_requested'
  | 'theme_changed'
  // D10 dashboard
  | 'calls_filtered'
  | 'calls_bulk_handled'
  | 'calls_exported'
  | 'agent_created'
  | 'agent_published'
  | 'agent_settings_saved'
  | 'agent_deleted'
  | 'prompt_saved'
  | 'version_restored'
  // D11 dashboard
  | 'number_added'
  | 'number_updated'
  | 'number_released'
  | 'auto_topup_saved'
  | 'payment_portal_opened'
  | 'workspace_settings_saved'
  | 'member_invited'
  | 'member_role_changed'
  | 'member_removed'
  | 'ownership_transferred'
  | 'notification_settings_saved'
  | 'call_reported'
  | 'support_ticket_opened'
  | 'support_ticket_replied';

export function track(event: AnalyticsEvent, props: Record<string, string | number | boolean | null | undefined> = {}) {
  if (!initialised) return;
  posthog.capture(event, { workspace_id: workspaceStore.get(), ...props });
}

export function identify(userId: string, props: Record<string, string | number | boolean> = {}) {
  if (!initialised) return;
  posthog.identify(userId, props);
}

export function resetAnalytics() {
  if (initialised) posthog.reset();
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  React.useEffect(() => {
    initAnalytics();
  }, []);
  React.useEffect(() => {
    if (!initialised || !pathname) return;
    posthog.capture('$pageview', { $current_url: window.location.href, path: pathname, workspace_id: workspaceStore.get() });
  }, [pathname]);
  return <>{children}</>;
}
