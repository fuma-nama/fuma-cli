export interface AsyncCache<V> {
  cached: (
    key: string,
    fn: (
      /**
       * set a cache value before the compute function completes.
       *
       * useful to handle recursive access.
       */
      presolve: (v: V) => Defer<V>,
    ) => V | Promise<V>,
  ) => V | Promise<V>;
  $value: <T>() => AsyncCache<T>;
  invalidate: (key: string) => void;
}

/**
 * cache for async resources, finished promises will be resolved into original value, otherwise wrapped with a promise.
 */
export function createCache<V extends object>(): AsyncCache<V> {
  const store = new Map<string, V | Promise<V>>();

  return {
    cached(key, fn) {
      let cached = store.get(key);
      if (cached) return cached;

      cached = fn((v) => {
        const deferred = defer(v);
        store.set(key, deferred.value);
        return deferred;
      });

      if (cached instanceof Promise) {
        const promise = cached.then((out) => {
          // replace with resolved if still exists
          if (store.get(key) === promise) {
            store.set(key, out);
          }

          return out;
        });
        store.set(key, promise);
        return promise;
      } else {
        store.set(key, cached);
        return cached;
      }
    },
    invalidate(key) {
      store.delete(key);
    },
    $value<T>() {
      return this as unknown as AsyncCache<T>;
    },
  };
}

interface Defer<V> {
  value: V;
  set: (value: V) => void;
}

function defer<V extends object>(initial: V): Defer<V> {
  const value: V = { ...initial };

  return {
    value,
    set(nextValue) {
      for (const k in value) {
        delete value[k];
      }

      Object.assign(value, nextValue);
    },
  };
}
