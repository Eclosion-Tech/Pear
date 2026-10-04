# @eclosion-tech/pulp

Block editor for the web — registry, chrome, RichText (y-prosemirror), split/merge, viewport-aware mounting.

**Pear consumes this package** via `pear/web/src/components/component-renderers/PearComponentTreeRenderer.tsx`, which wires SpacetimeDB subscriptions and reducers into pulp's storage-agnostic API.

## Quick start (inside the Pear monorepo)

```tsx
import {
  BlockEditor,
  PulpProvider,
  SurfaceFocusCoordinator,
  SurfaceFocusProvider,
  registerCoreBlocks,
} from "@eclosion-tech/pulp";

// Host app provides tree + mutations + config — see PearComponentTreeRenderer.
```

## Package boundary

| Pulp | Host (Pear) |
|---|---|
| `BlockTree`, `BlockNode`, registry | Substrate rows → `BlockTree` |
| `PulpMutations` | SpacetimeDB reducers |
| `BlockEditor`, RichText, chrome | Domain blocks (Container, Heading, …) |
| `SurfaceFocusCoordinator` | Insert subscription bridge |

Public npm publish is planned after sprint 3c.3–4 stabilizes the API.

## Tests

```bash
cd packages/pulp
pnpm test        # run once
pnpm test:watch  # watch mode
```

Vitest covers block navigation, structural actions (nest/merge/turn-into), heading Enter semantics, drag-move resolution, rich-text formatting, and ProseMirror keymap handlers.

## Undo / redo

`SurfaceUndoCoordinator` + `<SurfaceUndoProvider>` — document-wide Cmd-Z mixing Yjs text edits and structural ops. Host app wraps mutations via `coordinator.wrapMutations()` and wires `restoreBlock` for soft-delete undo (Pear: `restore_component`).

## Selection

Dragging from a text body (including its padding) selects characters across
successive text blocks. Dragging from the outer margin selects whole blocks;
drag handles still reorder blocks. The gesture keeps its original mode until
release. Shift-click and Shift-arrow extend text selections. Cmd/Ctrl+A selects
all text bodies on the surface, including off-screen text.

Cross-block text ranges support copy/cut, rich-text paste, replacement typing,
deletion, inline formatting, and grouped undo/redo. Adjacent leaf blocks join on
replacement; ranges crossing nested structure or media edit only the selected
text and preserve that structure. Block-type changes and link editing remain
single-block actions.

`SurfaceTextSelection` tracks Yjs-relative endpoints and pins selected editors
while scrolling. ProseMirror decorations paint each portion because browser
selections cannot reliably span separate editing hosts. Text undo managers live
with their Y.Doc so viewport unmounts do not discard their history.
