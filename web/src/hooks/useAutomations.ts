"use client";

import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";

export function useAutomationControlData() {
  const [rules, isReady] = useTable(tables.automation_rule);
  const [actions] = useTable(tables.automation_action);
  const [conditions] = useTable(tables.automation_condition);
  const [capabilities] = useTable(tables.automation_capability);
  const [events] = useTable(tables.automation_event_queue);
  const [runLogs] = useTable(tables.automation_run_log);

  return { rules, actions, conditions, capabilities, events, runLogs, isReady };
}

export function useValidateAutomation() {
  return useReducer(reducers.validateAutomation);
}

export function useSetAutomationMode() {
  return useReducer(reducers.setAutomationMode);
}

export function useEnableAutomation() {
  return useReducer(reducers.enableAutomation);
}

export function useDisableAutomation() {
  return useReducer(reducers.disableAutomation);
}

export function useInvokeAutomation() {
  return useReducer(reducers.invokeAutomation);
}

export type AutomationControlData = ReturnType<typeof useAutomationControlData>;
export type AutomationRuleRow = AutomationControlData["rules"][number];
export type AutomationActionRow = AutomationControlData["actions"][number];
export type AutomationConditionRow = AutomationControlData["conditions"][number];
export type AutomationCapabilityRow = AutomationControlData["capabilities"][number];
export type AutomationEventRow = AutomationControlData["events"][number];
export type AutomationRunLogRow = AutomationControlData["runLogs"][number];
