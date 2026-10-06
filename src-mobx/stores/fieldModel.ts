import { compareStructural, computed } from "mobx";
import type { $ZodIssue } from "zod/v4/core";

/**
 * A field as observers read it: its issues. Read inside a reaction or
 * `observer`, MobX re-runs only when this field's own issues change.
 */
export type FieldModel = {
  readonly issues: readonly $ZodIssue[];
};

/**
 * A field model over a validation that reads observables. `issues` becomes a
 * lazy computed: cached while observed, recomputed only when something it
 * read changes (the field, or a field its rules read), gone with its store.
 * Issues equal to the last ones keep the last ones: no re-run for observers.
 */
export const createFieldModel = (issues: () => readonly $ZodIssue[]): FieldModel => {
  const cachedIssues = computed(issues, { equals: compareStructural });
  return {
    get issues() {
      return cachedIssues.get();
    },
  };
};
