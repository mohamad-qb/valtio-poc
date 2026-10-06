import "@shared/styles/multiDeal.css";
import { memo } from "react";
import clsx from "clsx";
import { Deal } from "./Deal.tsx";
import { DealIdProvider } from "../providers/DealIdProvider.tsx";
import { useOnMount } from "@shared/hooks/useOnMount.ts";
import { activeDealSet } from "../../stores/tabsSlice.ts";
import { addNewDeal } from "../../stores/thunks.ts";
import { useAppDispatch, useAppSelector } from "../../hooks.ts";

const SingleDeal = memo(
  ({ isActive, dealId }: { isActive: boolean; dealId: string }) => {
    if (!isActive) return null;
    return (
      <DealIdProvider dealId={dealId}>
        <Deal />
      </DealIdProvider>
    );
  },
);

SingleDeal.displayName = "SingleDeal";

/** Selects only the deal ids and the active id: edits inside a deal never re-render it. */
export const MultiDeal = memo(() => {
  const dispatch = useAppDispatch();
  const dealIds = useAppSelector((state) => state.tabs.dealIds);
  const activeDealId = useAppSelector((state) => state.tabs.activeDealId);

  useOnMount(() => {
    dispatch(addNewDeal());
  });

  if (dealIds.length === 0) {
    return <div>Loading...</div>;
  }

  return (
    <section>
      <div className="multi-deal__tabs">
        {dealIds.map((dealId, index) => (
          <button
            key={dealId}
            className={clsx("button", {
              "button--active": dealId === activeDealId,
            })}
            onClick={() => dispatch(activeDealSet(dealId))}
          >
            Tab {index + 1}
          </button>
        ))}

        <button className="button" onClick={() => dispatch(addNewDeal())}>
          Add New Deal
        </button>
      </div>
      <div>
        {dealIds.map((dealId) => (
          <SingleDeal
            key={dealId}
            isActive={dealId === activeDealId}
            dealId={dealId}
          />
        ))}
      </div>
    </section>
  );
});

MultiDeal.displayName = "MultiDeal";
