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

## Editable references

`Reference` stores `{ surfaceId: "…", blockId?: "…" }`. Omitting `blockId`
includes the source page's root. A reference has no stored children: its framed
contents are the original source subtree, rendered with separate occurrence IDs.
The outer handle moves/removes the inclusion; inner handles edit the source.

Hosts provide `PulpConfig.references`: a `Source` component that subscribes to
the target surface and supplies its tree, raw mutations, and read-only status;
plus link parsing and source-link generation. Pear wires this to the existing
scoped component subscriptions and source-page access rules. `/Reference` offers
a page picker or a pasted page/block link. The backend registry migration must
be published before the new slash item appears in an existing workspace.

Two reference levels expand automatically. Deeper references require explicit
expansion; sources are subscribed when their frame approaches the viewport.
Current-path cycle detection shows a source link instead of recursively expanding
an ancestor. Reusing the same source in separate branches remains supported.
Deeper frames stop adding indentation. Missing or inaccessible sources show a
recoverable notice, and readable sources without write permission render statically.

Each occurrence owns selection, focus, drag targets, and undo. Mounted text
occurrences synchronize immediately within the same persistence namespace while
retaining separate Yjs undo state. Saving still uses the host's normal persistence
path. A reference to one text block keeps Enter/paste inside that document;
structural operations cannot create siblings outside the included subtree.

This first version contains selection and drag operations within each reference.
Dragging across reference boundaries and continuous cross-reference selection
remain follow-ups. Block links copied inside a reference point to the source.

## Selection behavior

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
