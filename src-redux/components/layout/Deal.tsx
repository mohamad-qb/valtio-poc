import "@shared/styles/deal.css";
import { memo, useMemo } from "react";
import { DealGrid } from "@shared/grid/DealGrid.tsx";
import { createPathGridSource } from "@shared/grid/pathGridSource.ts";
import { createPathDeal } from "../../stores/pathDeal.ts";
import { useAppStore } from "../../hooks.ts";
import { DealHeader } from "./DealHeader.tsx";
import { useDealId } from "../providers/DealIdProvider.tsx";

export const Deal = memo(() => {
  const dealId = useDealId();
  const store = useAppStore();
  const source = useMemo(() => createPathGridSource(createPathDeal(store, dealId)), [store, dealId]);

  return (
    <section className="deal">
      <DealHeader />
      <DealGrid source={source} />
    </section>
  );
});

Deal.displayName = "Deal";
