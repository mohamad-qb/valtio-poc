import "@shared/styles/deal.css";
import { memo, useMemo } from "react";
import { DealGrid } from "@shared/grid/DealGrid.tsx";
import { createPathGridSource } from "@shared/grid/pathGridSource.ts";
import { createPathDeal } from "../../stores/pathDeal.ts";
import { DealHeader } from "./DealHeader.tsx";
import { useDealStore } from "../providers/DealStoreProvider.tsx";

export const Deal = memo(() => {
  const dealStore = useDealStore();
  const source = useMemo(() => createPathGridSource(createPathDeal(dealStore)), [dealStore]);

  return (
    <section className="deal">
      <DealHeader />
      <DealGrid source={source} />
    </section>
  );
});

Deal.displayName = "Deal";
