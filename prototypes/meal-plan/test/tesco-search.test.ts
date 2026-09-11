import { test } from "node:test";
import assert from "node:assert/strict";

import { fromSearchResult } from "../src/integrations/tesco.ts";

// Shaped like basketeer's SearchResult (node_modules/basketeer/dist/models.d.ts).
const RESULT = {
  sku: "254656543",
  tpnb: "050221307",
  title: "Tesco Lean Beef Steak Mince 5% Fat 500G",
  brand: "TESCO",
  imageUrl: null,
  price: { actual: 4.25, unitPrice: 8.5, unitOfMeasure: "kg" },
  quantityRules: {
    productType: null,
    averageWeight: null,
    minWeight: null,
    maxWeight: null,
    increment: null,
    bulkBuyLimit: null,
    catchWeightOptions: [],
  },
  available: true,
  onOffer: true,
  promotions: [
    {
      description: "£3.75 Clubcard Price",
      startDate: null,
      endDate: null,
      attributes: [],
      priceAfterDiscount: 3.75,
      priceBeforeDiscount: 4.25,
    },
  ],
};

test("a Tesco result keeps its shelf price, its offer and its page", () => {
  assert.deepEqual(fromSearchResult(RESULT), {
    sku: "254656543",
    title: "Tesco Lean Beef Steak Mince 5% Fat 500G",
    price: { each: 4.25, perUnit: 8.5, unit: "kg" },
    offer: "£3.75 Clubcard Price",
    available: true,
    url: "https://www.tesco.com/groceries/en-GB/products/254656543",
  });
});

test("a result with no price loses the price, not the product", () => {
  const bare = fromSearchResult({
    ...RESULT,
    price: { actual: null, unitPrice: null, unitOfMeasure: null },
    available: null,
    promotions: [],
  });
  assert.deepEqual(bare, {
    sku: "254656543",
    title: "Tesco Lean Beef Steak Mince 5% Fat 500G",
    url: "https://www.tesco.com/groceries/en-GB/products/254656543",
  });
});

test("out of stock is passed on, because it stops Find all choosing it", () => {
  assert.equal(fromSearchResult({ ...RESULT, available: false }).available, false);
});
