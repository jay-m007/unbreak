import { makeClient } from "demo-lib";

const client = makeClient("https://api.example.com");

export async function main() {
  const user = await client.getUser("42");
  client.send("ana@example.com", "hi");
  const shout = client.format("hello", { upper: true });
  const upper = true;
  const quiet = client.format("x", { upper });
  client.closeConnection(true);
  const n: number = client.total();
  client.legacy();
  return [user, shout, quiet, n];
}
