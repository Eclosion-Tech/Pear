import { registerRenderer } from "../registry";
import { ContainerRenderer } from "./Container";
import { RichTextRenderer } from "./RichText";
import { HeadingRenderer } from "./Heading";
import { ImageRenderer } from "./Image";
import { InputRenderer } from "./Input";
import { ButtonRenderer } from "./Button";
import { CodeRefRenderer } from "./CodeRef";
import { DataBoundPlaceholder } from "./DataBoundPlaceholder";

/**
 * Side-effecting module that wires the v1 built-in renderers into the
 * shared `registry` map. Imported once at app bootstrap (see the
 * `ComponentTreeRenderer`'s static import).
 *
 * The 11 seeded built-ins in `pear/server/spacetimedb/src/pages/components.rs`
 * (`builtin_specs`): Container, RichText, Heading, Image, Form, Input,
 * Button, Table, Card, List, CodeRef.
 *
 * Sprint 1 ships read-only renderers for the seven non-data-bound types
 * (Container, RichText, Heading, Image, Input, Button, CodeRef) and a
 * shared placeholder for the four data-bound types (Form, Table, Card,
 * List). Sprint 4 replaces the placeholders with full implementations.
 */
let registered = false;

export function registerBuiltinRenderers(): void {
  if (registered) return;
  registered = true;

  registerRenderer("Container", ContainerRenderer);
  registerRenderer("RichText", RichTextRenderer);
  registerRenderer("Heading", HeadingRenderer);
  registerRenderer("Image", ImageRenderer);
  registerRenderer("Input", InputRenderer);
  registerRenderer("Button", ButtonRenderer);
  registerRenderer("CodeRef", CodeRefRenderer);

  registerRenderer("Form", DataBoundPlaceholder);
  registerRenderer("Table", DataBoundPlaceholder);
  registerRenderer("Card", DataBoundPlaceholder);
  registerRenderer("List", DataBoundPlaceholder);
}
