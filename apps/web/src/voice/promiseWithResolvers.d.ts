// The shared voice controller uses Promise.withResolvers, which web's ES2023 lib predates.
interface PromiseConstructor {
  withResolvers<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
}
