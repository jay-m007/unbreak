import { faker, fakerDE } from "@faker-js/faker";

export interface User {
  id: string;
  name: string;
  code: string;
  company: string;
  joined: Date;
  birthday: Date;
  account: string;
}

export function makeUser(): User {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    code: faker.random.alphaNumeric(8),
    company: faker.company.bs(),
    joined: faker.date.past(2),
    birthday: faker.date.between("1970-01-01", "2000-12-31"),
    account: faker.finance.account(),
  };
}

export function germanSlogan(): string {
  return fakerDE.company.bsNoun();
}
