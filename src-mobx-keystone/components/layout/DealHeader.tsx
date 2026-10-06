import { observer } from "mobx-react-lite";
import { CalcBar } from "@shared/components/CalcBar.tsx";
import { groupDefinitions, groupTypes } from "@shared/groups.ts";
import { multiTabStore } from "../../stores/multiTabStore.ts";
import { useDealStore } from "../providers/DealStoreProvider.tsx";

export const DealHeader = observer(() => {
  const deal = useDealStore();
  const { devtools } = multiTabStore;

  return (
    <>
    <CalcBar
      calc={deal.calc.data}
      isReady={deal.isReady}
      isAutocalcEnabled={devtools.isAutocalcEnabled}
      onToggleAutocalc={() => devtools.toggleAutocalcEnabled()}
      onCalculate={() => deal.calculate()}
    />
    <div className="deal__toolbar">
      {groupTypes.map((groupType) => (
        <button
          key={groupType}
          className="button"
          onClick={() => deal.addNewGroup(groupType)}
        >
          Add {groupDefinitions[groupType].label}
        </button>
      ))}

      <button className="button" onClick={() => devtools.toggleSpotPriceStreamEnabled()}>
        Toggle Spot Price Stream (
        {devtools.isSpotPriceStreamEnabled ? "Enabled" : "Disabled"})
      </button>
    </div>
    </>
  );
});

DealHeader.displayName = "DealHeader";
