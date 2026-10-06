import { z } from "zod";
import { dateInDays, daysUntil, isOnOrAfter } from "../lib/date.ts";
import { optionalNumber, optionalString } from "../lib/schemas.ts";
import { DEFAULT_SETTLEMENT_STYLE, settlementStyles } from "../settlementStyles.ts";
import { type ProductUi, defineProduct } from "./productDefinition.ts";

export type AverageProductStore = {
  ui: ProductUi;
  data: {
    productType: "AverageProduct";
    cashSettlement: {
      settlementCcy: string;
      /** Only while `settlementStyle` is Cash (see `fieldOptions`). */
      settlementFixingSource?: string;
    };
    avroCommon: {
      base: {
        buySell: string;
        ccyPair: string;
        deliveryDate: string;
        expiryCut: string;
        expiryDate: string;
        expiryDays: number;
        notional: {
          notionalCcy: string;
          amount: number;
        };
        premiumCcy: string;
        premiumDate: string;
      };
      callPut: string;
      strike: string;
    };
    settlementStyle: string;
  };
};

const ccySchema = z.string().max(6, "Must be at most 6 characters");
const dateSchema = optionalString(z.iso.date("Must be a valid date"));

export const averageProduct = defineProduct<AverageProductStore["data"]>({
  label: "Average Product",

  fields: [
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.notional.notionalCcy" },
      position: { field: "notionalCcy" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.notional.notionalCcy", ccySchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.notional.amount" },
      position: { field: "notionalAmount" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.notional.amount", optionalNumber(z.number().positive("Must be greater than 0"))] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.premiumCcy" },
      position: { field: "premiumCcy" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.premiumCcy", ccySchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.strike" },
      position: { field: "strike" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.strike", z.string().max(3, "Must be at most 3 characters")] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.callPut" },
      position: { field: "callPut" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.callPut", optionalString(z.enum(["Call", "Put"]))] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.buySell" },
      position: { field: "buySell" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.buySell", optionalString(z.enum(["Buy", "Sell"]))] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.ccyPair" },
      position: { field: "ccyPair" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.ccyPair", optionalString(z.string().regex(/^[A-Z]{6}$/, "Must be 6 uppercase letters, e.g. EURUSD"))] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryDate" },
      position: { field: "expiryDate" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryDate", dateSchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryDays" },
      position: { field: "expiryDays" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryDays", optionalNumber(z.number().int().min(0, "Expiry date is in the past"))] },
    },

    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryCut" },
      position: { field: "expiryCut" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.expiryCut", z.string().max(10, "Must be at most 10 characters")] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.deliveryDate" },
      position: { field: "deliveryDate" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.deliveryDate", dateSchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.premiumDate" },
      position: { field: "premiumDate" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.avroCommon.base.premiumDate", dateSchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.settlementStyle" },
      position: { field: "settlementStyle" },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.settlementStyle", z.enum(settlementStyles)] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.cashSettlement.settlementCcy" },
      position: { field: "settlementCcy" },
      visibility: { if: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.settlementStyle", "Cash"] },
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.cashSettlement.settlementCcy", ccySchema] },
    },
    {
      props: { path: "groups.$GROUP_ID.products.$PRODUCT_ID.data.cashSettlement.settlementFixingSource" },
      position: { field: "settlementFixingSource" },
      // an option id; its options come from the API, per settlement style. A Cash
      // product has none only until they first arrive: while they load (the deal
      // isn't ready then anyway, a request is pending) or after they failed (O8:
      // the rest of the deal keeps working), so a missing one is no issue
      validation: { schema: ["groups.$GROUP_ID.products.$PRODUCT_ID.data.cashSettlement.settlementFixingSource", z.string().optional()] },
    },
  ],

  rules: {
    deliveryDate: [
      {
        dependsOn: ["expiryDate"],
        message: "Delivery date can't be before expiry date",
        // read defensively: data written by path may lack the object
        isValid: (data) =>
          isOnOrAfter(data.avroCommon?.base?.deliveryDate ?? "", data.avroCommon?.base?.expiryDate ?? ""),
      },
    ],
  },

  derived: {
    expiryDays: {
      dependsOn: ["expiryDate"],
      compute: (data) => daysUntil(data.avroCommon?.base?.expiryDate),
      // typing a number of days moves the expiry date that many days from today
      write: (days) => ({ fieldId: "expiryDate", value: dateInDays(days) }),
    },
  },

  createData: (deal) => ({
    productType: "AverageProduct",
    cashSettlement: {
      settlementCcy: "",
      // no settlementFixingSource: added once Cash's options load
    },
    avroCommon: {
      base: {
        buySell: "",
        ccyPair: "",
        deliveryDate: "",
        expiryCut: "",
        expiryDate: "",
        expiryDays: NaN, // derived from expiryDate
        notional: {
          notionalCcy: deal.notionalCcy,
          amount: deal.notionalAmount,
        },
        premiumCcy: deal.premiumCcy,
        premiumDate: "",
      },
      callPut: "",
      strike: "",
    },
    settlementStyle: DEFAULT_SETTLEMENT_STYLE,
  }),
});
