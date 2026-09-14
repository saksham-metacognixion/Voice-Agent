/*
  Warnings:

  - You are about to drop the column `payload` on the `webhook_events` table. All the data in the column will be lost.
  - Added the required column `payload_json` to the `webhook_events` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "plan_tier" AS ENUM ('trial', 'starter', 'growth', 'scale', 'pro', 'volume');

-- CreateEnum
CREATE TYPE "agent_tier" AS ENUM ('standard', 'premium');

-- CreateEnum
CREATE TYPE "agent_status" AS ENUM ('draft', 'live', 'paused');

-- CreateEnum
CREATE TYPE "version_source" AS ENUM ('generated', 'feedback', 'manual', 'regenerate');

-- CreateEnum
CREATE TYPE "knowledge_type" AS ENUM ('url', 'file', 'text');

-- CreateEnum
CREATE TYPE "knowledge_status" AS ENUM ('processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "phone_plan_option" AS ENUM ('new', 'forward', 'sip', 'port');

-- CreateEnum
CREATE TYPE "phone_plan_status" AS ENUM ('pending', 'executed');

-- CreateEnum
CREATE TYPE "phone_number_type" AS ENUM ('retell_twilio', 'retell_telnyx', 'custom_sip');

-- CreateEnum
CREATE TYPE "phone_number_status" AS ENUM ('provisioning', 'active', 'paused', 'releasing', 'released');

-- CreateEnum
CREATE TYPE "hours_mode" AS ENUM ('always', 'business', 'custom');

-- CreateEnum
CREATE TYPE "call_channel" AS ENUM ('phone', 'web');

-- CreateEnum
CREATE TYPE "call_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('registered', 'in_progress', 'ended', 'analyzed', 'declined');

-- CreateEnum
CREATE TYPE "decline_reason" AS ENUM ('balance', 'cap', 'blocked', 'hours', 'paused');

-- CreateEnum
CREATE TYPE "ledger_reason" AS ENUM ('trial', 'purchase', 'call', 'rental', 'kb', 'adjustment', 'expiry', 'refund', 'topup');

-- CreateEnum
CREATE TYPE "purchase_status" AS ENUM ('pending', 'paid', 'abandoned', 'refunded');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('super_admin', 'ops', 'finance', 'support', 'read_only');

-- CreateEnum
CREATE TYPE "reason_code" AS ENUM ('goodwill', 'service_issue', 'billing_error', 'promo', 'partner_deal', 'fraud_suspected', 'abuse_policy', 'customer_request', 'chargeback', 'expiry_extension', 'testing_internal', 'support_investigation', 'legal_request', 'other');

-- CreateEnum
CREATE TYPE "ticket_author_type" AS ENUM ('customer', 'staff', 'system');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "impersonation_mode" AS ENUM ('view', 'act');

-- CreateEnum
CREATE TYPE "blocklist_type" AS ENUM ('email', 'domain', 'phone', 'country');

-- CreateEnum
CREATE TYPE "data_request_type" AS ENUM ('delete', 'export');

-- AlterTable
ALTER TABLE "webhook_events" DROP COLUMN "payload",
ADD COLUMN     "payload_json" JSONB NOT NULL,
ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_provider_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatar_url" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tos_accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "address_json" JSONB,
    "website" TEXT,
    "plan_tier" "plan_tier" NOT NULL DEFAULT 'trial',
    "concurrency_cap" INTEGER NOT NULL DEFAULT 2,
    "kb_allowance" INTEGER NOT NULL DEFAULT 0,
    "business_hours_json" JSONB,
    "stripe_customer_id" TEXT,
    "auto_topup_json" JSONB,
    "onboarding_step" INTEGER NOT NULL DEFAULT 1,
    "onboarding_completed_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "paused_reason" TEXT,
    "recording_default" BOOLEAN NOT NULL DEFAULT true,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "custom_deal_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "member_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "member_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" INET,
    "meta_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "new_message" TEXT NOT NULL DEFAULT 'instant',
    "low_balance_email" BOOLEAN NOT NULL DEFAULT true,
    "low_balance_sms" BOOLEAN NOT NULL DEFAULT false,
    "weekly_summary" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry_tags" TEXT[],
    "brief_prefill_json" JSONB NOT NULL,
    "steps_json" JSONB NOT NULL,
    "analysis_fields_json" JSONB NOT NULL,
    "rules_json" JSONB NOT NULL,
    "default_tier" "agent_tier" NOT NULL DEFAULT 'standard',
    "sample_audio_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT,
    "industry" TEXT,
    "tier" "agent_tier" NOT NULL DEFAULT 'standard',
    "primary_language" TEXT NOT NULL DEFAULT 'en-US',
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "voice_id" TEXT,
    "voice_speed" DECIMAL(4,2),
    "voice_temperature" DECIMAL(4,2),
    "retell_agent_id" TEXT,
    "retell_llm_id" TEXT,
    "retell_kb_id" TEXT,
    "draft_version" INTEGER,
    "published_version" INTEGER,
    "status" "agent_status" NOT NULL DEFAULT 'draft',
    "max_call_duration_s" INTEGER NOT NULL DEFAULT 600,
    "recording_enabled" BOOLEAN NOT NULL DEFAULT true,
    "addons_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "source" "version_source" NOT NULL,
    "brief_json" JSONB NOT NULL,
    "prompt_text" TEXT,
    "greeting" TEXT,
    "closing" TEXT,
    "analysis_schema_json" JSONB,
    "brief_card_json" JSONB,
    "scenarios_json" JSONB,
    "changes_json" JSONB,
    "feedback_text" TEXT,
    "lint_json" JSONB,
    "retell_agent_version" INTEGER,
    "stack_version" INTEGER,
    "created_by" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voices" (
    "retell_voice_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "accent" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preview_url" TEXT,
    "tier" "agent_tier" NOT NULL DEFAULT 'standard',
    "is_multilingual" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voices_pkey" PRIMARY KEY ("retell_voice_id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "type" "knowledge_type" NOT NULL,
    "name" TEXT NOT NULL,
    "retell_source_id" TEXT,
    "status" "knowledge_status" NOT NULL DEFAULT 'processing',
    "size_bytes" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "option" "phone_plan_option" NOT NULL,
    "country" CHAR(2),
    "area_code" TEXT,
    "toll_free" BOOLEAN NOT NULL DEFAULT false,
    "existing_number" TEXT,
    "sip_json" JSONB,
    "hours_mode" "hours_mode" NOT NULL DEFAULT 'always',
    "transfer_targets_json" JSONB,
    "allowed_countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "phone_plan_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID,
    "e164" TEXT NOT NULL,
    "nickname" TEXT,
    "type" "phone_number_type" NOT NULL,
    "country" CHAR(2),
    "area_code" TEXT,
    "toll_free" BOOLEAN NOT NULL DEFAULT false,
    "hours_mode" "hours_mode" NOT NULL DEFAULT 'always',
    "hours_override_json" JSONB,
    "transfer_targets_json" JSONB,
    "allowed_countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blocklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inbound_token" TEXT NOT NULL,
    "rental_credits" INTEGER NOT NULL DEFAULT 15,
    "next_rental_at" TIMESTAMP(3),
    "status" "phone_number_status" NOT NULL DEFAULT 'provisioning',
    "paused_at" TIMESTAMP(3),
    "retell_meta_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID,
    "agent_version" INTEGER,
    "number_id" UUID,
    "channel" "call_channel" NOT NULL,
    "direction" "call_direction" NOT NULL DEFAULT 'inbound',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "from_number" TEXT,
    "to_number" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_s" INTEGER,
    "disconnection_reason" TEXT,
    "tier" "agent_tier" NOT NULL DEFAULT 'standard',
    "rate" DECIMAL(6,3) NOT NULL DEFAULT 1.0,
    "config_version" INTEGER,
    "credits_charged" DECIMAL(12,2),
    "retell_cost_cents" INTEGER,
    "transcript_text" TEXT,
    "transcript_json" JSONB,
    "recording_url" TEXT,
    "analysis_json" JSONB,
    "outcome" TEXT,
    "handled_at" TIMESTAMP(3),
    "note" TEXT,
    "status" "call_status" NOT NULL DEFAULT 'registered',
    "decline_reason" "decline_reason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "credits" INTEGER NOT NULL,
    "plan_tier" "plan_tier" NOT NULL,
    "concurrency_cap" INTEGER NOT NULL,
    "kb_allowance" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID,
    "credits_total" DECIMAL(12,2) NOT NULL,
    "credits_remaining" DECIMAL(12,2) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "policy_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "delta" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "reason" "ledger_reason" NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "lot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pack_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "credits" INTEGER NOT NULL,
    "stripe_session_id" TEXT,
    "stripe_payment_intent" TEXT,
    "invoice_url" TEXT,
    "status" "purchase_status" NOT NULL DEFAULT 'pending',
    "is_auto_topup" BOOLEAN NOT NULL DEFAULT false,
    "promo_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "type" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "steps_json" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "threshold" DECIMAL(12,2),
    "sent_at" TIMESTAMP(3),
    "channel" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "auth_provider_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "staff_role" NOT NULL,
    "mfa_enforced" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_role_limits" (
    "role" "staff_role" NOT NULL,
    "credit_adjust_max_per_action" DECIMAL(12,2),
    "credit_adjust_max_per_day" DECIMAL(12,2),
    "refund_max_cents" INTEGER,
    "can_listen_recordings" BOOLEAN NOT NULL DEFAULT false,
    "can_change_plan" BOOLEAN NOT NULL DEFAULT false,
    "can_pause_tenant" BOOLEAN NOT NULL DEFAULT false,
    "can_edit_pricing_draft" BOOLEAN NOT NULL DEFAULT false,
    "can_publish_pricing" BOOLEAN NOT NULL DEFAULT false,
    "can_edit_agent_stack" BOOLEAN NOT NULL DEFAULT false,
    "can_publish_agent_stack" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_flags" BOOLEAN NOT NULL DEFAULT false,
    "can_view_as_customer" BOOLEAN NOT NULL DEFAULT false,
    "can_act_as_customer" BOOLEAN NOT NULL DEFAULT false,
    "can_delete_customer_data" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_staff" BOOLEAN NOT NULL DEFAULT false,
    "can_export" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_role_limits_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "staff_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staff_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "tenant_id" UUID,
    "reason_code" "reason_code",
    "note" TEXT,
    "before_json" JSONB,
    "after_json" JSONB,
    "ip" INET,
    "impersonation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "based_on_version" INTEGER,
    "config_json" JSONB NOT NULL,
    "edited_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_configs" (
    "version" INTEGER NOT NULL,
    "config_json" JSONB NOT NULL,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3),
    "change_summary" TEXT,
    "grandfather_mode" TEXT,

    CONSTRAINT "pricing_configs_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "stripe_price_map" (
    "pack_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "config_version" INTEGER NOT NULL,
    "stripe_product_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "stripe_price_map_pkey" PRIMARY KEY ("pack_id","currency","config_version")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "applies_to_packs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_uses" INTEGER,
    "per_customer_once" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "uses_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "credits" INTEGER NOT NULL,
    "caps_json" JSONB,
    "gates_json" JSONB,
    "payment_mode" TEXT NOT NULL DEFAULT 'checkout',
    "stripe_price_id" TEXT,
    "contract_start" TIMESTAMP(3),
    "contract_end" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_overrides" (
    "tenant_id" UUID NOT NULL,
    "concurrency_cap" INTEGER,
    "kb_allowance" INTEGER,
    "max_agents" INTEGER,
    "max_numbers" INTEGER,
    "gates_json" JSONB,
    "flags_json" JSONB,
    "reason" TEXT,
    "set_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_overrides_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "agent_stack_configs" (
    "version" INTEGER NOT NULL,
    "tiers_json" JSONB NOT NULL,
    "voice_overrides_json" JSONB,
    "guardrails_text" TEXT NOT NULL,
    "lint_json" JSONB,
    "generation_prompts_json" JSONB,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "agent_stack_configs_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "retell_cost_inputs" (
    "version" INTEGER NOT NULL,
    "costs_json" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retell_cost_inputs_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "credit_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "delta" DECIMAL(12,2) NOT NULL,
    "reason_code" "reason_code" NOT NULL,
    "note" TEXT,
    "customer_text" TEXT,
    "staff_id" UUID NOT NULL,
    "ticket_id" INTEGER,
    "impersonation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchase_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "credits_reversed" DECIMAL(12,2) NOT NULL,
    "stripe_refund_id" TEXT,
    "reason_code" "reason_code" NOT NULL,
    "staff_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" SERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requester_user_id" UUID,
    "subject" TEXT NOT NULL,
    "category" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" "ticket_status" NOT NULL DEFAULT 'open',
    "assignee_staff_id" UUID,
    "sla_first_response_due" TIMESTAMP(3),
    "sla_resolution_due" TIMESTAMP(3),
    "first_responded_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "csat" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linked_call_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linked_purchase_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" INTEGER NOT NULL,
    "author_type" "ticket_author_type" NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "attachments_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_flags" (
    "tenant_id" UUID NOT NULL,
    "flag" TEXT NOT NULL,
    "set_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_flags_pkey" PRIMARY KEY ("tenant_id","flag")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staff_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" "impersonation_mode" NOT NULL,
    "reason_code" "reason_code" NOT NULL,
    "ticket_id" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "audience_json" JSONB,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT,
    "default_on" BOOLEAN NOT NULL DEFAULT false,
    "rollout_pct" INTEGER NOT NULL DEFAULT 0,
    "tenant_overrides_json" JSONB,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "kill_switches" (
    "key" TEXT NOT NULL,
    "on" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "set_by" UUID,
    "expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kill_switches_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "blocklists" (
    "type" "blocklist_type" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "set_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocklists_pkey" PRIMARY KEY ("type","value")
);

-- CreateTable
CREATE TABLE "fraud_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "score" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reviewer_id" UUID,
    "decision" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" "data_request_type" NOT NULL,
    "requested_by" UUID,
    "due_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "job_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_provider_id_key" ON "users"("auth_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_customer_id_key" ON "tenants"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "tenants_plan_tier_idx" ON "tenants"("plan_tier");

-- CreateIndex
CREATE INDEX "tenants_created_at_idx" ON "tenants"("created_at");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_tenant_id_email_idx" ON "invites"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_tenant_id_user_id_key" ON "notification_settings"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "agents_tenant_id_status_idx" ON "agents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_no_key" ON "agent_versions"("agent_id", "version_no");

-- CreateIndex
CREATE INDEX "knowledge_sources_agent_id_idx" ON "knowledge_sources"("agent_id");

-- CreateIndex
CREATE INDEX "phone_plans_tenant_id_idx" ON "phone_plans"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_e164_key" ON "phone_numbers"("e164");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_inbound_token_key" ON "phone_numbers"("inbound_token");

-- CreateIndex
CREATE INDEX "phone_numbers_tenant_id_status_idx" ON "phone_numbers"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "phone_numbers_next_rental_at_idx" ON "phone_numbers"("next_rental_at");

-- CreateIndex
CREATE INDEX "calls_tenant_id_started_at_idx" ON "calls"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_tenant_id_status_idx" ON "calls"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "calls_number_id_started_at_idx" ON "calls"("number_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "credit_lots_tenant_id_expires_at_idx" ON "credit_lots"("tenant_id", "expires_at");

-- CreateIndex
CREATE INDEX "credit_ledger_tenant_id_created_at_idx" ON "credit_ledger"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "purchases_stripe_session_id_key" ON "purchases"("stripe_session_id");

-- CreateIndex
CREATE INDEX "purchases_tenant_id_created_at_idx" ON "purchases"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_tenant_id_created_at_idx" ON "jobs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_tenant_id_dismissed_at_idx" ON "alerts"("tenant_id", "dismissed_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_auth_provider_id_key" ON "staff_users"("auth_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE INDEX "staff_audit_log_staff_id_created_at_idx" ON "staff_audit_log"("staff_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "staff_audit_log_tenant_id_created_at_idx" ON "staff_audit_log"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE INDEX "custom_deals_tenant_id_idx" ON "custom_deals"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_adjustments_ledger_id_key" ON "credit_adjustments"("ledger_id");

-- CreateIndex
CREATE INDEX "credit_adjustments_tenant_id_created_at_idx" ON "credit_adjustments"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_stripe_refund_id_key" ON "refunds"("stripe_refund_id");

-- CreateIndex
CREATE INDEX "support_tickets_tenant_id_created_at_idx" ON "support_tickets"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets"("status", "priority");

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_notes_tenant_id_pinned_idx" ON "customer_notes"("tenant_id", "pinned");

-- CreateIndex
CREATE INDEX "impersonation_sessions_tenant_id_started_at_idx" ON "impersonation_sessions"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "fraud_reviews_status_idx" ON "fraud_reviews"("status");

-- CreateIndex
CREATE INDEX "data_requests_tenant_id_idx" ON "data_requests"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_custom_deal_id_fkey" FOREIGN KEY ("custom_deal_id") REFERENCES "custom_deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_voice_id_fkey" FOREIGN KEY ("voice_id") REFERENCES "voices"("retell_voice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_plans" ADD CONSTRAINT "phone_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_plans" ADD CONSTRAINT "phone_plans_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_audit_log" ADD CONSTRAINT "staff_audit_log_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_audit_log" ADD CONSTRAINT "staff_audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_audit_log" ADD CONSTRAINT "staff_audit_log_impersonation_id_fkey" FOREIGN KEY ("impersonation_id") REFERENCES "impersonation_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_price_map" ADD CONSTRAINT "stripe_price_map_config_version_fkey" FOREIGN KEY ("config_version") REFERENCES "pricing_configs"("version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_deals" ADD CONSTRAINT "custom_deals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_overrides" ADD CONSTRAINT "tenant_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "credit_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_staff_id_fkey" FOREIGN KEY ("assignee_staff_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_flags" ADD CONSTRAINT "customer_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
