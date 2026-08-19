import {
  registerRenderer,
} from "@eclosion-tech/pulp";
import { ContainerRenderer } from "./Container";
import { ImageRenderer } from "./Image";
import { ImageBlockRenderer } from "./ImageBlock";
import { FileBlockRenderer } from "./FileBlock";
import { InputRenderer } from "./Input";
import { ButtonRenderer } from "./Button";
import { CodeRefRenderer } from "./CodeRef";
import { PageLinkRenderer } from "./PageLink";
import { ConversationRenderer } from "./Conversation";
import { AudioRenderer } from "./Audio";
import { FormRenderer } from "./Form";
import { DataBoundPlaceholder } from "./DataBoundPlaceholder";
import { MarkdownTableRenderer } from "./MarkdownTable";
import {
  BulletListItemRenderer,
  ChecklistItemRenderer,
  NumberedListItemRenderer,
} from "./DocumentListItem";

/**
 * Pear-specific block renderers — registered alongside pulp's core
 * `RichText` via `registerCoreBlocks()` in `PearComponentTreeRenderer`.
 */
let registered = false;

export function registerPearBuiltinRenderers(): void {
  if (registered) return;
  registered = true;

  registerRenderer("Container", ContainerRenderer);
  registerRenderer("Image", ImageRenderer);
  registerRenderer("ImageBlock", ImageBlockRenderer);
  registerRenderer("FileBlock", FileBlockRenderer);
  registerRenderer("Input", InputRenderer);
  registerRenderer("Button", ButtonRenderer);
  registerRenderer("CodeRef", CodeRefRenderer);
  registerRenderer("PageLink", PageLinkRenderer);
  registerRenderer("Conversation", ConversationRenderer);
  registerRenderer("Audio", AudioRenderer);
  registerRenderer("Form", FormRenderer);
  registerRenderer("BulletListItem", BulletListItemRenderer);
  registerRenderer("NumberedListItem", NumberedListItemRenderer);
  registerRenderer("ChecklistItem", ChecklistItemRenderer);
  registerRenderer("MarkdownTable", MarkdownTableRenderer);

  registerRenderer("Table", DataBoundPlaceholder);
  registerRenderer("Card", DataBoundPlaceholder);
  registerRenderer("List", DataBoundPlaceholder);
}
