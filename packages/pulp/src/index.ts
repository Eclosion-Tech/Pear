// Types
export type {
  BlockId,
  BlockNode,
  BlockTree,
  BlockTypeDefinition,
  BlockYjsState,
  BlockInsertEvent,
  PulpMutations,
  PulpConfig,
  PulpContextValue,
  PropValidationResult,
} from "./types";

// Context
export { PulpProvider, usePulp, usePulpOptional } from "./context/PulpProvider";

// Focus coordinator
export {
  SurfaceFocusProvider,
  useSurfaceFocus,
  SurfaceFocusCoordinator,
} from "./focus/SurfaceFocusProvider";
export type {
  SurfaceFocusValue,
  ArmForInsertOpts,
  FocusPlacement,
} from "./focus/SurfaceFocusCoordinator";
export { knownSiblingIdsForParent, siblingsForParent } from "./focus/insertFocusHelpers";

// Editor shell
export { BlockEditor, ComponentTreeRenderer } from "./BlockEditor";
export { BlockNodeView, ComponentNodeView } from "./BlockNodeView";
export {
  registerRenderer,
  getRenderer,
  getRegisteredTypes,
  assertRegistryAgainstDefs,
} from "./registry";
export type {
  BlockRenderer,
  BlockRendererProps,
  ComponentRenderer,
  ComponentRendererProps,
} from "./registry";
export { registerCoreBlocks } from "./registerCoreBlocks";

// Chrome + menus
export { BlockChrome, BlockChromeHeaderControls } from "./BlockChrome";
export type { BlockChromeGutterMode } from "./BlockChrome";
export { useBlockChromeHandles } from "./BlockChromeHandlesContext";
export { BlockMenu } from "./BlockMenu";
export { SlashMenu, SPRINT_3B_SLASH_ITEMS } from "./SlashMenu";
export type { SlashMenuItem } from "./SlashMenu";
export {
  UnregisteredComponentFallback,
  SkeletonDoc,
  EmptyTreeFallback,
} from "./fallbacks";

// Rich text
export { RichTextRenderer } from "./rich-text/RichText";
export { RichTextEditor } from "./rich-text/RichTextEditor";
export { FormattingToolbar } from "./rich-text/FormattingToolbar";
export {
  richTextSchema,
  PROSEMIRROR_FRAGMENT_KEY,
} from "./rich-text/richTextSchema";
export { yDocToHtml } from "./rich-text/yjsToHtml";

export { validateComponentProps } from "./componentProps";
export type { ValidationResult, ValidationError, JsonSchema } from "./componentProps";

// Undo / redo coordinator
export {
  SurfaceUndoProvider,
  useSurfaceUndo,
  SurfaceUndoCoordinator,
} from "./undo/SurfaceUndoProvider";
export type { UndoEntry } from "./undo/SurfaceUndoCoordinator";

// Drag-and-drop
export { ContainerDropZone } from "./dnd/ContainerDropZone";
export {
  containerDropId,
  CONTAINER_DROP_PREFIX,
  parseContainerDropId,
  parseBlockSortableId,
} from "./dnd/containerDropId";
export {
  resolveDragMove,
  isAncestorOf,
  type DragMoveArgs,
} from "./dnd/resolveDragMove";

// Block menu actions + deep links
export {
  duplicateBlock,
  mergePlainTextIntoRichText,
  turnIntoBlock,
  nestBlockUnderPreviousSibling,
  unnestBlock,
  isDocumentListItemType,
  DOCUMENT_LIST_ITEM_TYPES,
} from "./blockActions";
export {
  blockLinkHash,
  buildBlockLink,
  copyBlockLink,
  parseBlockLinkHash,
  BLOCK_LINK_HASH_PREFIX,
} from "./blockLink";
export { yDocToPlainText } from "./rich-text/yjsToHtml";

// Cross-block keyboard navigation
export { getBlockSibling } from "./navigation/blockNavigation";
