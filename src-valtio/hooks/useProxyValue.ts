import { useCallback, useMemo, useSyncExternalStore } from "react";
import { subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";

/**
 * Reads one key of one proxy. Unlike `useSnapshot` on a whole store, it is
 * only notified by changes inside `proxyObject` (not the entire store tree),
 * does no snapshotting, and re-renders only when the value itself changes.
 * Bound to the proxy passed in — the parent object must not be replaced.
 */
export const useProxyValue = <T extends object, K extends keyof T>(
  proxyObject: T,
  key: K,
): T[K] => {
  const subscribeToKey = useCallback(
    (onChange: () => void) => subscribeKey(proxyObject, key, onChange),
    [proxyObject, key],
  );
  return useSyncExternalStore(subscribeToKey, () => proxyObject[key]);
};

/**
 * A value derived from a proxy (a primitive, compared by value), re-read on
 * any change inside it and re-rendering only when the value itself changes.
 */
export const useProxyDerived = <T>(proxyObject: object, read: () => T): T => {
  const subscribeToProxy = useCallback(
    (onChange: () => void) => subscribe(proxyObject, onChange),
    [proxyObject],
  );
  return useSyncExternalStore(subscribeToProxy, read);
};

/**
 * A list of strings read from a proxy, re-rendering only when the list
 * itself changes — a string signature is compared by value.
 */
const useProxyStrings = (
  proxyObject: object,
  read: () => readonly string[],
): string[] => {
  const signature = useProxyDerived(proxyObject, () => read().join(","));
  return useMemo(() => (signature ? signature.split(",") : []), [signature]);
};

/** Own keys of a proxy; re-renders only when keys are added or removed. */
export const useProxyKeys = (proxyObject: object): string[] =>
  useProxyStrings(proxyObject, () => Object.keys(proxyObject));

/** Items of a proxied string array; re-renders only when they change. */
export const useProxyArray = (proxyArray: readonly string[]): string[] =>
  useProxyStrings(proxyArray, () => proxyArray);
