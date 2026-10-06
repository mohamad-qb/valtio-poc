/**
 * Async options for dropdowns, independent of any state library.
 *
 * A field declares where its options come from (`fieldOptions` in
 * `fields.ts`): a fixed list, or an `OptionsSource` loaded with another
 * field's value as the parameter. Each app keeps the loaded lists in its own
 * store (keyed by `optionsKey`) using the pure helpers below, and reconciles
 * the field with `reconcileOption` when new options arrive.
 */

export type Option = { value: string; label: string };

export type OptionsState = {
  status: "loading" | "loaded" | "error";
  options: readonly Option[];
};

export type OptionsSource = {
  readonly id: string;
  /** Concurrent loads of one parameter share a request; later loads fetch again. */
  load(param: string): Promise<readonly Option[]>;
};

/** Wraps a fetcher as an options source. */
export const defineOptionsSource = (
  id: string,
  fetchOptions: (param: string) => Promise<readonly Option[]>,
): OptionsSource => {
  const inFlight = new Map<string, Promise<readonly Option[]>>();
  return {
    id,
    load(param) {
      const pending = inFlight.get(param);
      if (pending) return pending;
      const request = fetchOptions(param).finally(() => inFlight.delete(param));
      inFlight.set(param, request);
      return request;
    },
  };
};

/** Where a source's options for one parameter are kept in an app's store. */
export const optionsKey = (source: OptionsSource, param: string) =>
  `${source.id}:${param}`;

const sameOptions = (a: readonly Option[], b: readonly Option[]) =>
  a.length === b.length &&
  a.every((option, i) => option.value === b[i].value && option.label === b[i].label);

/**
 * The state while (re)loading: what is already shown stays shown, so a
 * reload never flashes "Loading…" (or re-renders) for fields that have options.
 */
export const optionsLoading = (previous: OptionsState | undefined): OptionsState =>
  previous ?? { status: "loading", options: [] };

/** The state after a successful load; the same object when nothing changed. */
export const optionsLoaded = (
  previous: OptionsState | undefined,
  options: readonly Option[],
): OptionsState =>
  previous?.status === "loaded" && sameOptions(previous.options, options)
    ? previous
    : { status: "loaded", options };

/** The state after a failed load: a list already shown is kept. */
export const optionsFailed = (previous: OptionsState | undefined): OptionsState =>
  previous?.status === "loaded" ? previous : { status: "error", options: [] };

/**
 * The value to keep once options arrive: the current one if it is still an
 * option; else the option it is the label of (a pasted label: the clipboard
 * carries labels); otherwise the first option (`""` if there are none).
 */
export const reconcileOption = (
  current: unknown,
  options: readonly Option[],
): string => {
  const value = current === undefined || current === null ? "" : String(current);
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => option.label === value);
  return match ? match.value : (options[0]?.value ?? "");
};
