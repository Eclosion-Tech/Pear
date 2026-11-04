import { expect, it } from "vitest";
import { filterSlashItems } from "../../../packages/pulp/src/SlashMenu";
import { workspaceTemplateSlashItems } from "../components/component-renderers/pearSlashItems";
it("slash discovery pins current workspace versions and hides archived or missing packages", () => {
  const family = {
    templateId: "workspace:contacts",
    name: "Contact form",
    description: "Capture a lead",
    tagsJson: '["sales"]',
    latestVersion: "1.1.0",
    archived: false,
  };
  const version = {
    templateId: family.templateId,
    version: "1.1.0",
    contentHash: "a".repeat(64),
    packageJson: JSON.stringify({ format: "trellis_authored_template_v1" }),
  };
  const items = workspaceTemplateSlashItems(
    [
      family,
      { ...family, templateId: "archived", archived: true },
      { ...family, templateId: "missing" },
    ],
    [version],
  );
  expect(items).toHaveLength(1);
  expect(filterSlashItems(items, "sales")).toHaveLength(1);
  expect(items[0].defaultProps).toEqual({
    kind: "component-template",
    templateId: family.templateId,
    version: "1.1.0",
    hash: version.contentHash,
  });
  expect(items[0].defaultProps).not.toHaveProperty("sources");
  expect(
    workspaceTemplateSlashItems(
      [family],
      [{ ...version, packageJson: "invalid" }],
    ),
  ).toEqual([]);
});
