import { slugify, pad } from "tinyutil";

export const a = slugify("Hello World");
export const b = pad(a, 20);
