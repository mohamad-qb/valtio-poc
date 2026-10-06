import {
  type Column,
  type Formatter,
  SlickCellSelectionModel,
  SlickGrid,
  SlickRange,
} from "slickgrid";
import { DEAL_SETTINGS_FIRST_ROW, dealSettings } from "../dealSettings.ts";
import { type FieldId, fields } from "../fields.ts";
import { cellText } from "./cellValues.ts";
import { parseTsv, toTsv } from "./clipboard.ts";
import { createFieldEditor } from "./fieldEditor.ts";
import {
  type CellKey,
  type CellRef,
  DEAL_COLUMN_ID,
  type GridColumn,
  type GridSource,
  SETTINGS_COLUMN_ID,
} from "./gridSource.ts";
import { fieldRowsInOrder, nextInOrder } from "./navigation.ts";
import { pasteStatus, pasteWrites } from "./paste.ts";

/** One grid row per field, in display order. */
type Row = { fieldId: FieldId; label: string };
const rows: Row[] = fields.map(({ id, label }) => ({ fieldId: id, label }));
const rowOf = new Map(rows.map((row, index) => [row.fieldId, index]));

/** The deal settings subgrid: its rows, a few rows down. */
const settingRows = dealSettings.map((_, index) => DEAL_SETTINGS_FIRST_ROW + index);
const settingAt = (row: number) => dealSettings[row - DEAL_SETTINGS_FIRST_ROW];

const COLUMN_WIDTH = 160;
/** The settings subgrid, the deal and the field labels stay in view: the last frozen column is the labels. */
const FROZEN_COLUMN = 3;
/**
 * Narrower than the frozen columns plus one product column (a phone), nothing
 * is frozen: the products would have no room, so everything scrolls instead.
 */
const FREEZE_MIN_WIDTH = (FROZEN_COLUMN + 2) * COLUMN_WIDTH;
const frozenColumnFor = (width: number) => (width >= FREEZE_MIN_WIDTH ? FROZEN_COLUMN : -1);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** What Tab can move focus to, outside the grid. */
const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable=""], [contenteditable="true"], [tabindex]';

/** A column of labels: the settings', or the fields'. Not a value column. */
type LabelColumn = { labels: "settings" | "fields" };
type LayoutColumn = GridColumn | LabelColumn;
const isLabels = (column: LayoutColumn | undefined): column is LabelColumn =>
  Boolean(column && "labels" in column);

/**
 * The grid's columns, left to right: the settings subgrid (labels, values),
 * the deal, the field labels, then every product.
 */
const layoutOf = (columns: readonly GridColumn[]): LayoutColumn[] => [
  { labels: "settings" },
  { id: SETTINGS_COLUMN_ID, title: "" },
  ...columns.filter((column) => column.id === DEAL_COLUMN_ID),
  { labels: "fields" },
  ...columns.filter((column) => column.id !== DEAL_COLUMN_ID),
];

/** The same columns, in the same groups: only titles may differ. */
const isSameLayout = (a: readonly LayoutColumn[], b: readonly LayoutColumn[]) =>
  a.length === b.length &&
  a.every((column, cell) => {
    const other = b[cell];
    if (isLabels(column) || isLabels(other)) {
      return isLabels(column) && isLabels(other) && column.labels === other.labels;
    }
    return column.id === other.id && column.group?.id === other.group?.id;
  });

/** SlickGrid's private listener registry, where it keeps every header it ever bound. */
type BoundEvent = {
  element: Element | Window | Document;
  eventName: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};
const boundEventsOf = (grid: SlickGrid<Row>) =>
  (grid as unknown as { _bindingEventService?: { getBoundedEvents?: () => BoundEvent[] } })
    ._bindingEventService?.getBoundedEvents?.();
const HEADER_CELL_CLASSES = ["slick-header-column", "slick-headerrow-column", "slick-resizable-handle"];

/**
 * Mounts the deal grid: fields as rows; the settings subgrid, the deal and
 * the field labels frozen on the left, then every product, under its group's
 * header. Returns the unmount. Cells are painted by SlickGrid from `source`;
 * the only repaints are the cells the source reports changed, so React
 * renders nothing here.
 *
 * Keyboard: arrows move to the neighbouring cell, across subgrids; Tab, and
 * Enter after an edit, go through the settings top-down and each field
 * column by priority (`navigationOrder`), and Tab past the last cell (or
 * Shift+Tab before the first) leaves the grid. Typing starts an edit,
 * Escape cancels it. Copy and paste work on the selected range as
 * tab-separated text, and a paste is a single `source.write` batch.
 *
 * Columns change (groups added, removed, cloned) at most once per tick,
 * however many changes the source reports: an open editor is committed
 * first (or cancelled, when its column is going or its text doesn't fit),
 * and the active cell follows its column.
 */
export const mountDealGrid = (container: HTMLElement, source: GridSource) => {
  let layout = layoutOf(source.getColumns());
  const cellOf = (columnId: string) =>
    layout.findIndex((column) => !isLabels(column) && column.id === columnId);
  const dataCells = () => layout.flatMap((column, cell) => (isLabels(column) ? [] : [cell]));

  /** What a grid cell holds: the row's setting in the settings column, else the row's field. */
  const keyAt = (row: number, columnId: string): CellKey | undefined =>
    columnId === SETTINGS_COLUMN_ID ? settingAt(row)?.id : rows[row].fieldId;
  const refAt = (row: number, cell: number): CellRef | null => {
    const column = layout[cell];
    if (!column || isLabels(column)) return null;
    const key = keyAt(row, column.id);
    return key ? { columnId: column.id, fieldId: key } : null;
  };
  const viewAt = (row: number, cell: number) => {
    const ref = refAt(row, cell);
    return ref ? source.getCell(ref.columnId, ref.fieldId) : null;
  };

  // a repainted cell keeps the classes it had unless they are removed: list every state
  const formatter: Formatter<Row> = (row, cell) => {
    const view = viewAt(row, cell);
    let text = cellText(view);
    if (text === "" && view?.options?.status === "loading") text = "Loading…";
    if (text === "" && view?.options?.status === "error") text = "Failed to load";
    const isOutsideSubgrid = !refAt(row, cell);
    const states = {
      "grid-cell--void": isOutsideSubgrid,
      "grid-cell--none": !view && !isOutsideSubgrid,
      "grid-cell--error": Boolean(view?.hasError),
      "grid-cell--readonly": Boolean(view?.readOnly),
      "grid-cell--pending": Boolean(view?.options && view.options.status !== "loaded"),
    };
    const classes = (on: boolean) =>
      Object.entries(states).filter(([, isOn]) => isOn === on).map(([name]) => name).join(" ");
    return {
      text: escapeHtml(text),
      addClasses: classes(true),
      removeClasses: classes(false),
      toolTip: view?.readOnly ? "Calculated: read-only" : "",
    };
  };
  const settingLabelFormatter: Formatter<Row> = (row) => {
    const setting = settingAt(row);
    return setting
      ? { text: escapeHtml(setting.label), removeClasses: "grid-cell--void" }
      : { text: "", addClasses: "grid-cell--void" };
  };

  const FieldEditor = createFieldEditor(source);
  const toSlickColumns = (): Column<Row>[] =>
    layout.map((column, cell) => {
      if (isLabels(column)) {
        const isSettings = column.labels === "settings";
        return {
          id: `labels-${column.labels}`,
          name: "",
          field: "label",
          width: COLUMN_WIDTH,
          focusable: false,
          selectable: false,
          resizable: false,
          headerCssClass: isSettings ? "grid-header--void" : "grid-header--labels",
          cssClass: "grid-cell--label",
          formatter: isSettings ? settingLabelFormatter : (row) => escapeHtml(rows[row].label),
        };
      }
      const isDeal = column.id === DEAL_COLUMN_ID;
      const isSettings = column.id === SETTINGS_COLUMN_ID;
      // the first product of each group draws the line between groups
      const previous = layout[cell - 1];
      const startsGroup =
        Boolean(column.group) && (isLabels(previous) || previous?.group?.id !== column.group?.id);
      return {
        id: column.id,
        name: escapeHtml(column.title),
        field: "fieldId",
        width: COLUMN_WIDTH,
        resizable: false,
        headerCssClass: isSettings
          ? "grid-header--void"
          : `${isDeal ? "grid-header--deal" : "grid-header--product"}${startsGroup ? " grid-col--group-start" : ""}`,
        cssClass: `${isDeal ? "grid-col--deal" : ""}${startsGroup ? " grid-col--group-start" : ""}`,
        editor: FieldEditor,
        params: { keyAt: (item: Row) => keyAt(rowOf.get(item.fieldId)!, column.id) },
        formatter,
      };
    });

  // the settings column only has cells on the subgrid's rows: elsewhere it can't be focused or selected
  const settingsOff = { [SETTINGS_COLUMN_ID]: { focusable: false, selectable: false } };
  const data = {
    getLength: () => rows.length,
    getItem: (row: number) => rows[row],
    getItemMetadata: (row: number) => (settingAt(row) ? null : { columns: settingsOff }),
  };

  const grid = new SlickGrid<Row>(container, data, toSlickColumns(), {
    editable: true,
    enableCellNavigation: true,
    autoEdit: false, // on by default: every click and move would open an editor
    autoEditByKeypress: true,
    asyncEditorLoading: false,
    autoHeight: true,
    rowHeight: 32,
    headerRowHeight: 32,
    frozenColumn: frozenColumnFor(container.clientWidth),
    createPreHeaderPanel: true,
    showPreHeaderPanel: true,
    preHeaderPanelHeight: 32,
    enableColumnReorder: false,
    // every commit, typed or pasted, goes to the source as a batch
    editCommandHandler: (_item, _column, command) => {
      const ref = refAt(command.row, command.cell);
      if (ref) source.write([{ ...ref, value: command.serializedValue }]);
    },
  });
  const selection = new SlickCellSelectionModel();
  grid.setSelectionModel(selection);

  // derived and missing cells can't be edited
  grid.onBeforeEditCell.subscribe((_event, { row, cell }) => {
    const view = row === undefined || cell === undefined ? null : viewAt(row, cell);
    return Boolean(view && !view.readOnly);
  });

  // --- the status line: paste reports, and why an edit can't be committed
  const status = document.createElement("div");
  status.className = "deal-grid__status";
  status.setAttribute("role", "status");
  const showStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle("deal-grid__status--error", isError);
  };
  grid.onValidationError.subscribe((_event, { validationResults }) => {
    showStatus(validationResults.msg ?? "Invalid value", true);
  });
  grid.onBeforeCellEditorDestroy.subscribe(() => {
    if (status.classList.contains("deal-grid__status--error")) showStatus("");
  });

  // --- keyboard order: Tab, and Enter after an edit, go through each column in its own order
  const canStop = (row: number, cell: number) => {
    const view = viewAt(row, cell);
    return Boolean(view && !view.readOnly);
  };
  const rowsInOrder = (cell: number) => {
    const column = layout[cell];
    if (!column || isLabels(column)) return [];
    return column.id === SETTINGS_COLUMN_ID ? settingRows : fieldRowsInOrder;
  };
  /** Past the last cell (or before the first), Tab moves focus to what comes after (before) the grid. */
  const leaveGrid = (step: 1 | -1) => {
    const outside = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) =>
        !container.contains(element) &&
        element.tabIndex >= 0 &&
        element.getClientRects().length > 0 &&
        !element.closest("[inert]"),
    );
    const isAfter = (element: HTMLElement) =>
      Boolean(container.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const next = step > 0 ? outside.find(isAfter) : outside.reverse().find((element) => !isAfter(element));
    if (next) next.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // nothing there: on to the browser's
  };
  grid.onKeyDown.subscribe((event, { row, cell }) => {
    const key = event.getNativeEvent<KeyboardEvent>();
    if (key.altKey || key.ctrlKey || key.metaKey || row === undefined || cell === undefined) return;
    const isTab = key.key === "Tab";
    const isEnterAfterEdit = key.key === "Enter" && !key.shiftKey && grid.getCellEditor() !== null;
    if (!isTab && !isEnterAfterEdit) return;
    if (!grid.getEditorLock().commitCurrentEdit()) return;
    const step = isTab && key.shiftKey ? -1 : 1;
    const target = nextInOrder(row, cell, step, { first: 0, count: layout.length }, rowsInOrder, canStop);
    event.stopImmediatePropagation(); // not the grid's own (spatial) Tab
    if (target) {
      key.preventDefault();
      grid.gotoCell(target.row, target.cell);
    } else if (isTab) {
      key.preventDefault();
      leaveGrid(step);
    }
  });

  // --- copy / paste: the selected range (or the active cell) as tab-separated text
  const selectedRange = () => {
    const [range] = selection.getSelectedRanges();
    const active = grid.getActiveCell();
    if (range) return range;
    return active && { fromRow: active.row, fromCell: active.cell, toRow: active.row, toCell: active.cell };
  };

  const onCopy = (event: ClipboardEvent) => {
    const range = selectedRange();
    if (grid.getCellEditor() || !range || !event.clipboardData) return; // an editor copies its own text
    const cells = dataCells().filter((cell) => cell >= range.fromCell && cell <= range.toCell);
    const copied = [];
    for (let row = range.fromRow; row <= range.toRow; row++) {
      copied.push(cells.map((cell) => cellText(viewAt(row, cell))));
    }
    event.clipboardData.setData("text/plain", toTsv(copied));
    event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent) => {
    const range = selectedRange();
    const text = event.clipboardData?.getData("text/plain");
    if (grid.getCellEditor() || !range || !text) return; // an editor pastes into itself
    event.preventDefault();
    const { writes, skipped, pasted } = pasteWrites({
      data: parseTsv(text),
      range,
      rowCount: rows.length,
      dataCells: dataCells(),
      cellAt: (row, cell) => {
        const ref = refAt(row, cell);
        return ref && { ref, view: source.getCell(ref.columnId, ref.fieldId) };
      },
    });
    source.write(writes);
    selection.setSelectedRanges([new SlickRange(pasted.fromRow, pasted.fromCell, pasted.toRow, pasted.toCell)]);
    showStatus(pasteStatus(writes, skipped, (ref) => source.getCell(ref.columnId, ref.fieldId)));
  };
  container.addEventListener("copy", onCopy);
  container.addEventListener("paste", onPaste);
  container.after(status);

  // --- group headers, above their products: right of the frozen columns, or after them when nothing is frozen
  const isFrozen = () => (grid.getOptions().frozenColumn ?? -1) >= 0;
  const renderGroupHeaders = () => {
    const runs: { id: string; title: string; span: number }[] = [];
    for (const column of layout) {
      if (isLabels(column) || !column.group) continue;
      const last = runs[runs.length - 1];
      if (last?.id === column.group.id) last.span++;
      else runs.push({ ...column.group, span: 1 });
    }
    const groups = runs
      .map(
        ({ id, title, span }) =>
          `<div class="grid-group" style="width:${span * COLUMN_WIDTH}px">` +
          `<span class="grid-group__title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>` +
          `<button class="grid-group__action" aria-label="Clone" title="Clone ${escapeHtml(title)}" data-group-action="clone" data-group-id="${id}">⧉</button>` +
          `<button class="grid-group__action" aria-label="Remove" title="Remove ${escapeHtml(title)}" data-group-action="remove" data-group-id="${id}">✕</button>` +
          `</div>`,
      )
      .join("");
    const left = grid.getPreHeaderPanelLeft();
    const right = grid.getPreHeaderPanelRight();
    if (isFrozen()) {
      left.innerHTML = "";
      right.innerHTML = groups;
      return;
    }
    const leading = layout.findIndex((column) => !isLabels(column) && column.group);
    const spacer = `<div class="grid-group-spacer" style="width:${(leading < 0 ? layout.length : leading) * COLUMN_WIDTH}px"></div>`;
    left.innerHTML = spacer + groups;
    if (right) right.innerHTML = "";
  };
  const onGroupAction = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-group-action]");
    const groupId = button?.dataset.groupId;
    if (!groupId) return;
    if (button.dataset.groupAction === "clone") source.cloneGroup(groupId);
    else source.removeGroup(groupId);
  };
  container.addEventListener("click", onGroupAction);
  renderGroupHeaders();

  /**
   * After SlickGrid rebuilt its headers: it empties the old header row but
   * keeps every old header bound in its listener list (about 30 nodes and 24
   * listeners per rebuild). Unbind the ones no longer in the page.
   */
  const releaseDetachedHeaders = () => {
    const bound = boundEventsOf(grid);
    if (!bound) return;
    for (let i = bound.length - 1; i >= 0; i--) {
      const { element, eventName, listener, options } = bound[i];
      if (!(element instanceof Element) || element.isConnected) continue;
      if (!HEADER_CELL_CLASSES.some((name) => element.classList.contains(name))) continue;
      element.removeEventListener(eventName, listener, options);
      bound.splice(i, 1);
    }
  };
  const afterHeadersRebuilt = () => {
    releaseDetachedHeaders();
    renderGroupHeaders();
  };

  // --- columns follow the source, rebuilt at most once per tick
  let isMounted = true;
  let columnsQueued = false;
  const updateColumns = () => {
    columnsQueued = false;
    if (!isMounted) return;
    const next = layoutOf(source.getColumns());
    if (isSameLayout(layout, next)) {
      // only titles changed: retitle the headers in place
      next.forEach((column, cell) => {
        const current = layout[cell];
        if (!isLabels(column) && !isLabels(current) && column.title !== current.title) {
          grid.updateColumnHeader(column.id, escapeHtml(column.title));
        }
      });
      layout = next;
      renderGroupHeaders();
      return;
    }
    // settle the editor and the active cell while they still point into the old columns
    const active = grid.getActiveCell();
    const activeColumn = active ? layout[active.cell] : undefined;
    const activeId = activeColumn && !isLabels(activeColumn) ? activeColumn.id : null;
    const isKept = activeId !== null && next.some((column) => !isLabels(column) && column.id === activeId);
    const hadFocus = container.contains(document.activeElement);
    if (grid.getCellEditor() && !(isKept && grid.getEditorLock().commitCurrentEdit())) {
      grid.getEditorLock().cancelCurrentEdit();
    }
    grid.resetActiveCell();
    selection.setSelectedRanges([]);
    layout = next;
    grid.setColumns(toSlickColumns());
    afterHeadersRebuilt();
    if (active && activeId !== null && isKept) {
      grid.setActiveCell(active.row, cellOf(activeId));
      if (hadFocus) grid.focus();
    }
  };
  const stopColumns = source.subscribeColumns(() => {
    if (columnsQueued) return;
    columnsQueued = true;
    queueMicrotask(updateColumns);
  });

  // --- frozen columns only where there is room for them and a product
  const onResize = () => {
    const frozenColumn = frozenColumnFor(container.clientWidth);
    if (frozenColumn === (grid.getOptions().frozenColumn ?? -1)) return;
    grid.setOptions({ frozenColumn });
    afterHeadersRebuilt();
  };
  window.addEventListener("resize", onResize);

  // --- repaint only what changed
  const repaint = (row: number, cell: number) => {
    const editing = grid.getCellEditor() && grid.getActiveCell();
    // the cell being edited keeps its draft; it repaints when the edit ends
    if (editing && editing.row === row && editing.cell === cell) return;
    grid.updateCell(row, cell);
  };
  const rowOfRef = ({ columnId, fieldId }: CellRef) =>
    columnId === SETTINGS_COLUMN_ID
      ? settingRows[dealSettings.findIndex(({ id }) => id === fieldId)]
      : rowOf.get(fieldId as FieldId);
  const stopCells = source.subscribeCells((cells) => {
    for (const ref of cells) {
      const cell = cellOf(ref.columnId);
      const row = rowOfRef(ref);
      if (cell >= 0 && row !== undefined) repaint(row, cell);
    }
  });
  const spotRow = rowOf.get("spotStream");
  const stopSpot = source.spotPriceStream.subscribe(() => {
    if (spotRow !== undefined) repaint(spotRow, cellOf(DEAL_COLUMN_ID));
  });

  return () => {
    isMounted = false;
    stopColumns();
    stopCells();
    stopSpot();
    window.removeEventListener("resize", onResize);
    container.removeEventListener("copy", onCopy);
    container.removeEventListener("paste", onPaste);
    container.removeEventListener("click", onGroupAction);
    status.remove();
    grid.destroy();
  };
};
