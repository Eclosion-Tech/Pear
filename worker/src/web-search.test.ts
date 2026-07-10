import test from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGoResults } from "./tools.js";

test("DuckDuckGo parser tolerates attribute ordering and unwraps redirect URLs", () => {
  const html = `
    <div class="result__body">
      <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstory&amp;rut=x"
         rel="nofollow" class="result__a"><b>Example</b> Story</a>
      <a href="https://example.com/story" class="result__snippet">
        A <strong>useful</strong> result.
      </a>
    </div>
    <div class="result__body">
      <a class='result__a extra' data-x='1' href='https://pear.pro'>Pear</a>
      <div class='result__snippet'>Workspace docs</div>
    </div>`;

  assert.deepEqual(parseDuckDuckGoResults(html), [
    {
      title: "Example Story",
      url: "https://example.com/story",
      snippet: "A useful result.",
    },
    {
      title: "Pear",
      url: "https://pear.pro",
      snippet: "Workspace docs",
    },
  ]);
});

test("DuckDuckGo parser returns no results for a bot challenge page", () => {
  assert.deepEqual(parseDuckDuckGoResults("<html><h1>Robot check</h1></html>"), []);
});
