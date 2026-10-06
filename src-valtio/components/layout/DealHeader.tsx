import { CalcBar } from "@shared/components/CalcBar.tsx";
import { isCalcReady } from "@shared/calc.ts";
import { optionsStore } from "../../stores/optionsStore.ts";
import { useDealStore } from "../providers/DealStoreProvider.tsx";
import { useProxyDerived, useProxyValue } from "../../hooks/useProxyValue.ts";
import { multiTabStore } from "../../stores/multiTabStore.ts";
import { memo, useCallback } from "react";
import {
  type GroupType,
  groupTypes,
  groupDefinitions,
} from "@shared/groups.ts";

export const DealHeader = memo(() => {
  const dealStore = useDealStore();
  // multiTabStore contains every deal, so a snapshot of it was notified on
  // every keystroke; the devtools object only changes when toggled
  const isSpotPriceStreamEnabled = useProxyValue(
    multiTabStore.devtools,
    "isSpotPriceStreamEnabled",
  );

  const isAutocalcEnabled = useProxyValue(multiTabStore.devtools, "isAutocalcEnabled");
  const calc = useProxyValue(dealStore, "calc");
  // derived from the products' data: re-checked as it changes, re-rendered only when it flips
  const hasValidationErrors = useProxyDerived(dealStore.groups, () => dealStore.hasValidationErrors);
  const pending = useProxyValue(optionsStore, "pending");
  const isReady = isCalcReady(hasValidationErrors, pending);

  const handleAddNewGroup = useCallback(
    (groupType: GroupType) => {
      dealStore.actions.addNewGroup(groupType);
    },
    [dealStore.actions],
  );

  return (
    <>
    <CalcBar
      calc={calc}
      isReady={isReady}
      isAutocalcEnabled={isAutocalcEnabled}
      onToggleAutocalc={multiTabStore.actions.toggleAutocalcEnabled}
      onCalculate={dealStore.actions.calculate}
    />
    <div className="deal__toolbar">
      {groupTypes.map((groupType) => (
        <button
          key={groupType}
          className="button"
          onClick={() => handleAddNewGroup(groupType)}
        >
          Add {groupDefinitions[groupType].label}
        </button>
      ))}

      <button
        className="button"
        onClick={() => {
          multiTabStore.actions.toggleSpotPriceStreamEnabled();
        }}
      >
        Toggle Spot Price Stream (
        {isSpotPriceStreamEnabled ? "Enabled" : "Disabled"}
        )
      </button>
    </div>
    </>
  );
});

DealHeader.displayName = "DealHeader";
