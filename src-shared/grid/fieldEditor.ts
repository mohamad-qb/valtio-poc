import type { Editor, EditorArguments, EditorConstructor, EditorValidationResult } from "slickgrid";
import { parseNumberText } from "./cellValues.ts";
import { type CellKey, type GridSource, inputTypeOf, labelOf } from "./gridSource.ts";

const toInputValue = (value: unknown) =>
  value === undefined || value === null || (typeof value === "number" && Number.isNaN(value))
    ? ""
    : String(value);

/**
 * The grid's one editor, for every field: a text, number or date input, or
 * a dropdown over the cell's options. It never writes the value itself: the
 * grid hands every commit to the source (`editCommandHandler`). A number
 * input only commits a number (or nothing, which clears the cell): other
 * text fails `validate`, and the editor stays open with it.
 */
export const createFieldEditor = (source: GridSource): EditorConstructor =>
  class FieldEditor implements Editor {
    private control!: HTMLInputElement | HTMLSelectElement;
    private initial = "";
    private readonly fieldId: CellKey;
    private readonly columnId: string;
    // a dropdown keeps the arrow keys (choosing an option); the grid ignores them
    keyCaptureList?: number[];

    private readonly args: EditorArguments;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SlickGrid's constructor type is generic over the grid
    constructor(args: EditorArguments<any, any, any>) {
      this.args = args;
      // the settings column holds the row's setting, every other column the row's field
      this.fieldId = args.column.params.keyAt(args.item);
      this.columnId = String(args.column.id);
      this.init();
    }

    init() {
      const type = inputTypeOf(this.fieldId);
      const view = source.getCell(this.columnId, this.fieldId);
      if (type === "select") {
        const select = document.createElement("select");
        const placeholder = new Option("—", "");
        placeholder.disabled = true;
        select.append(placeholder, ...(view?.options?.options ?? []).map(({ value, label }) => new Option(label, value)));
        this.control = select;
        this.keyCaptureList = [38, 40];
      } else {
        const input = document.createElement("input");
        input.type = type === "date" ? "date" : "text";
        // left/right move the caret, not the active cell
        input.addEventListener("keydown", (event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.stopPropagation();
        });
        this.control = input;
      }
      this.control.className = "grid-editor";
      this.control.setAttribute("aria-label", labelOf(this.fieldId));
      this.args.container.append(this.control);
      this.focus();
    }

    destroy() {
      this.control.remove();
    }

    focus() {
      this.control.focus();
      // typing over a cell replaces its text, like a spreadsheet
      if (this.control instanceof HTMLInputElement && this.control.type === "text") this.control.select();
    }

    loadValue() {
      const view = source.getCell(this.columnId, this.fieldId);
      this.control.value = toInputValue(view?.value);
      this.initial = this.control.value;
      this.focus(); // loaded after init: select the loaded text
    }

    serializeValue() {
      return inputTypeOf(this.fieldId) === "number"
        ? (parseNumberText(this.control.value) ?? NaN)
        : this.control.value;
    }

    applyValue() {
      // never called: commits go to the source
    }

    isValueChanged() {
      return this.control.value !== this.initial;
    }

    validate(): EditorValidationResult {
      const isNumber = inputTypeOf(this.fieldId) !== "number" || parseNumberText(this.control.value) !== null;
      this.control.setAttribute("aria-invalid", String(!isNumber));
      return isNumber
        ? { valid: true, msg: null }
        : { valid: false, msg: `${labelOf(this.fieldId)}: "${this.control.value.trim()}" is not a number` };
    }
  };
