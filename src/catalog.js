// Demo store catalog and three demo suppliers.
//
// The suppliers stand in for wholesale supplier APIs or price feeds. Each one
// names the same goods differently and not every listing carries a GTIN, so
// matching "is this the same product?" is a real problem for the agent.

export const PRODUCTS = [
  { sku: 'COF-1KG', name: 'Arabica Coffee Beans, Medium Roast, 1 kg', gtin: '4901234567894', price: 32.0, stock: 0, reorder_point: 0, image: '☕' },
  { sku: 'BOT-750', name: 'Insulated Stainless Water Bottle 750 ml', gtin: '0812345678901', price: 24.0, stock: 0, reorder_point: 0, image: '🧴' },
  { sku: 'EAR-PRO', name: 'Wireless Earbuds Pro (ANC)', gtin: '0198765432109', price: 79.0, stock: 0, reorder_point: 0, image: '🎧' },
  { sku: 'MAT-100', name: 'Ceremonial Matcha Powder 100 g (Uji)', gtin: '4987654321098', price: 28.0, stock: 0, reorder_point: 0, image: '🍵' },
];

// Supplier listings. `gtin: null` means the supplier does not publish it.
const SUPPLIERS = {
  A: {
    name: 'Supplier A (US wholesale)', country: 'US', since: '2025-03-01', rating: 4.8,
    items: [
      { id: 'A-1001', title: 'Coffee Beans Arabica Med Roast 1kg Bag', gtin: '4901234567894', cost: 19.5, shipping: 4.0, eta: 2, stock: 120 },
      { id: 'A-1002', title: '750ml Insulated Bottle, Stainless Steel', gtin: null, cost: 11.0, shipping: 3.5, eta: 2, stock: 60 },
      { id: 'A-1003', title: 'ANC Wireless Earbuds "Pro"', gtin: '0198765432109', cost: 52.0, shipping: 3.0, eta: 3, stock: 15 },
      { id: 'A-1004', title: 'Matcha Green Tea Powder 100g', gtin: null, cost: 16.0, shipping: 4.0, eta: 4, stock: 30 },
    ],
  },
  B: {
    name: 'Supplier B (Japan, direct)', country: 'JP', since: '2024-11-10', rating: 4.9,
    items: [
      { id: 'B-77', title: 'Uji Matcha ceremonial grade 100 g', gtin: '4987654321098', cost: 11.0, shipping: 6.0, eta: 7, stock: 200 },
      { id: 'B-78', title: 'Coffee Beans 1 kg (Arabica, medium)', gtin: '4901234567894', cost: 18.0, shipping: 7.5, eta: 8, stock: 40 },
      { id: 'B-79', title: 'Stainless bottle 500 ml', gtin: '0812345678999', cost: 8.0, shipping: 5.0, eta: 8, stock: 90 },
    ],
  },
  C: {
    name: 'Supplier C (US marketplace)', country: 'US', since: '2026-10-20', rating: 4.1,
    items: [
      { id: 'C-9', title: 'Wireless Earbuds Pro ANC - Black', gtin: null, cost: 44.0, shipping: 2.0, eta: 2, stock: 8 },
      { id: 'C-10', title: 'Arabica Coffee 1kg medium roast whole bean', gtin: null, cost: 17.0, shipping: 3.0, eta: 3, stock: 25 },
      { id: 'C-11', title: 'Water Bottle Insulated 750 ml Stainless', gtin: '0812345678901', cost: 10.0, shipping: 3.0, eta: 3, stock: 0 },
    ],
  },
};

// Demo knob: price changes applied on top of the base list (supplier -> item -> new cost).
const overrides = new Map();

export function setSupplierCost(supplier, itemId, cost) {
  overrides.set(`${supplier}:${itemId}`, cost);
}

export function resetSupplierCosts() {
  overrides.clear();
}

/** What a supplier API would return right now. */
export function supplierFeed(id) {
  const s = SUPPLIERS[id];
  if (!s) return null;
  return {
    id, name: s.name, country: s.country, since: s.since, rating: s.rating,
    items: s.items.map((it) => {
      const cost = overrides.get(`${id}:${it.id}`) ?? it.cost;
      return { ...it, cost, base_cost: it.cost };
    }),
  };
}

export const SUPPLIER_IDS = Object.keys(SUPPLIERS);

/** PayPal account that receives a supplier's payout (sandbox business accounts). */
export function supplierPayee(id) {
  return process.env[`SUPPLIER_${id}_EMAIL`] || `supplier-${id.toLowerCase()}@example.com`;
}
