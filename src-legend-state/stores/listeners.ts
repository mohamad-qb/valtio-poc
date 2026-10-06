/**
 * An app listener that never throws into Legend-State's notifications: in
 * 3.0.0-beta.48 one that throws while a batch notifies stops every later
 * notification on the page (`endBatch` has no try/finally). Its error is
 * reported on its own instead.
 */
export const isolated =
  <Args extends unknown[]>(listener: (...args: Args) => void) =>
  (...args: Args) => {
    try {
      listener(...args);
    } catch (error) {
      if (typeof reportError === "function") reportError(error);
      else
        queueMicrotask(() => {
          throw error;
        });
    }
  };
