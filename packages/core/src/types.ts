export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Awaitable<T> = T | Promise<T>;

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, string | Record<string, string | undefined>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
