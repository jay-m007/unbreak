import { faker } from "@faker-js/faker";

const f = faker;

export function product() {
  return {
    title: f.commerce.productName(),
    price: faker.commerce.price(10, 200, 2, "₹"),
    sku: faker.random.numeric(6),
    month: faker.date.month({ abbr: true }),
  };
}

export function notes(): string[] {
  return faker.datatype.array(3).map(String);
}

const random = faker.random;
export const tag = random.word();
