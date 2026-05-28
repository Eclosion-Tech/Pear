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
export type { RichTextTextDensity } from "./rich-text/RichText";
export { RichTextEditor } from "./rich-text/RichTextEditor";
export type { EditorSurfaceMode } from "./rich-text/richTextKeymap";
export {
  handleRichTextEnter,
  handleRichTextBackspace,
  handleRichTextArrowUp,
  handleRichTextArrowDown,
  inlineMarksDisabled,
} from "./rich-text/richTextKeymap";
export { resolveHeadingEnter } from "./heading/headingEnter";
export type { HeadingEnterAction } from "./heading/headingEnter";
export { FormattingToolbar } from "./rich-text/FormattingToolbar";
export type { BlockToolbarActions } from "./rich-text/FormattingToolbar";
export { HeadingRenderer } from "./heading/HeadingRenderer";
export { AlignToolbarControls } from "./rich-text/AlignToolbarControls";
export { turnIntoToolbarItems, labelForBlock } from "./toolbarTurnIntoItems";
export {
  richTextSchema,
  PROSEMIRROR_FRAGMENT_KEY,
} from "./rich-text/richTextSchema";
export {
  applyColorMark,
  getSelectionMarkColor,
  getSelectionTextAlign,
  setParagraphTextAlign,
  normalizeTextAlign,
  headingPropsJson,
  plainTextToYDoc,
  TEXT_COLOR_SWATCHES,
  BACKGROUND_COLOR_SWATCHES,
} from "./rich-text/richTextFormatting";
export type { TextAlign } from "./rich-text/richTextFormatting";

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
  mergeBlockIntoDocumentPrev,
  deleteEmptyBlockAndFocusDocumentPrev,
  turnIntoBlock,
  nestBlockUnderPreviousSibling,
  unnestBlock,
  canNestBlock,
  canUnnestBlock,
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
export { getBlockSibling, getDocumentPrevBlock, getDocumentNextBlock } from "./navigation/blockNavigation";

// Block-level selection (marquee / cross-block drag / keyboard)
export {
  SurfaceSelectionProvider,
  useSurfaceSelection,
  useSurfaceSelectionOptional,
} from "./selection/SurfaceSelectionProvider";
export type { SurfaceSelectionValue } from "./selection/SurfaceSelectionProvider";
export { SurfaceSelectionController } from "./selection/SurfaceSelectionController";
