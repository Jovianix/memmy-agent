import type { ComputerHistoryObservationSettings } from "../../api/computer-history-contract.js";

export function hasLegacyHistoryScope(settings: ComputerHistoryObservationSettings): boolean {
  return settings.observation.defaultApplicationBehavior !== "observe"
    || settings.observation.defaultURLBehavior !== "observe"
    || settings.observation.rules.some((rule) => rule.behavior === "observe");
}

/** Only persist this replacement after an explicit scope choice and confirmation. */
export function historyExclusionScope(
  settings: ComputerHistoryObservationSettings,
  allowAll = false,
): ComputerHistoryObservationSettings {
  return {
    ...settings,
    observation: {
      defaultApplicationBehavior: "observe",
      defaultURLBehavior: "observe",
      rules: allowAll ? [] : settings.observation.rules.filter((rule) => rule.behavior === "do_not_observe"),
    },
  };
}
