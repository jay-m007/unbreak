export interface FormatOptions {
  uppercase?: boolean;
}

export declare class Client {
  users: { get(id: string): Promise<{ id: string }> };
  send(options: { to: string; body: string }): void;
  format(text: string, options?: FormatOptions): string;
  disconnect(force: boolean): void;
  count(): string;
}

export declare function createClient(url: string): Client;
