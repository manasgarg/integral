import type { ModelSelection } from "./model-selection.ts";

export interface ConversationOriginRoute {
  conversationId: string;
  provider: "discord";
  externalId: string;
  userId: string;
  channelId: string;
}

export type ScheduleTrigger =
  | { type: "recurring"; cron: string; timezone: string }
  | { type: "once"; runAt: string };

export interface ScheduleDefinition {
  id: string;
  revision: number;
  trigger: ScheduleTrigger;
  prompt: string;
  profile: ModelSelection;
  enabled: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  origin?: ConversationOriginRoute;
}

export type ScheduleOperation =
  "create" | "update" | "enable" | "disable" | "delete" | "restore";

export interface ScheduleHistoryEntry {
  commit: string;
  committedAt: string;
  scheduleId: string;
  revision: number;
  operation: ScheduleOperation;
  actor: string;
  timestamp: string;
}

export interface CreateSchedule {
  trigger: ScheduleTrigger;
  prompt: string;
  profile: ModelSelection;
  origin?: ConversationOriginRoute;
}

export interface UpdateSchedule {
  expectedRevision: number;
  trigger?: ScheduleTrigger;
  prompt?: string;
  profile?: ModelSelection;
}
