import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("dashboard shows small nonzero charges instead of rounding them to zero", () => {
  const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
  const source = /const usd = [^\n]+/.exec(html)![0];
  const usd = runInNewContext(source + "\nusd;");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(null), "$0.00");
  assert.equal(usd(0.00000001), "$0.00000001");
  assert.equal(usd(0.0000047), "$0.0000047");
  assert.equal(usd(0.000012), "$0.000012");
  assert.equal(usd(0.0000047 + 0.000012), "$0.0000167");
  assert.equal(usd(1), "$1.00");
  assert.equal(usd(1000), "$1,000.00");
});
