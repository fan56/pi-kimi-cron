import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeXml, renderCronFireXml } from "../index.ts";
import type { CronJobOrigin } from "../index.ts";

describe("escapeXml", () => {
	test("escapes ampersand", () => {
		assert.equal(escapeXml("a & b"), "a &amp; b");
	});

	test("escapes less-than", () => {
		assert.equal(escapeXml("a < b"), "a &lt; b");
	});

	test("escapes greater-than", () => {
		assert.equal(escapeXml("a > b"), "a &gt; b");
	});

	test("escapes double-quote", () => {
		assert.equal(escapeXml('say "hi"'), "say &quot;hi&quot;");
	});

	test("escapes apostrophe", () => {
		assert.equal(escapeXml("it's"), "it&apos;s");
	});

	test("escapes all five characters together", () => {
		assert.equal(
			escapeXml(`<a href="x">&'b"</a>`),
			`&lt;a href=&quot;x&quot;&gt;&amp;&apos;b&quot;&lt;/a&gt;`,
		);
	});

	test("leaves safe characters alone", () => {
		assert.equal(escapeXml("hello world 123"), "hello world 123");
	});

	test("order: & is escaped first (so we don't double-escape)", () => {
		// If `<` were escaped before `&`, then `&` would be double-escaped
		// when it was part of `&lt;`. Test that already-escaped sequences
		// would be re-escaped (intentional: escapeXml is a single-pass op
		// over raw input).
		assert.equal(escapeXml("a & b"), "a &amp; b");
		assert.equal(escapeXml("a &lt; b"), "a &amp;lt; b");
	});

	test("empty string returns empty string", () => {
		assert.equal(escapeXml(""), "");
	});
});

describe("renderCronFireXml", () => {
	const baseOrigin: CronJobOrigin = {
		kind: "cron_job",
		jobId: "abcdef01",
		fireId: "12345678",
		cron: "0 9 * * 1-5",
		recurring: true,
		coalescedCount: 1,
		stale: false,
		executionMode: "sub-agent",
	};

	test("contains expected XML blocks", () => {
		const xml = renderCronFireXml(baseOrigin, "do the thing");
		assert.ok(xml.includes("<cron_fire>"), "root tag");
		assert.ok(xml.includes("</cron_fire>"), "closing root tag");
		assert.ok(xml.includes("<job_id>abcdef01</job_id>"));
		assert.ok(xml.includes("<fire_id>12345678</fire_id>"));
		assert.ok(xml.includes("<cron>0 9 * * 1-5</cron>"));
		assert.ok(xml.includes("<recurring>true</recurring>"));
		assert.ok(xml.includes("<prompt>do the thing</prompt>"));
		assert.ok(xml.includes("<instructions>"));
		assert.ok(xml.includes("</instructions>"));
		assert.ok(xml.includes("<execution_mode>sub-agent</execution_mode>"));
	});

	test("omits coalesced_count when count is 1 (single fire)", () => {
		const xml = renderCronFireXml({ ...baseOrigin, coalescedCount: 1 }, "p");
		assert.ok(!xml.includes("<coalesced_count>"), "single fire should not include coalesced_count");
	});

	test("includes coalesced_count when count > 1", () => {
		const xml = renderCronFireXml({ ...baseOrigin, coalescedCount: 5 }, "p");
		assert.ok(xml.includes("<coalesced_count>5</coalesced_count>"));
	});

	test("omits stale block when stale=false", () => {
		const xml = renderCronFireXml({ ...baseOrigin, stale: false }, "p");
		assert.ok(!xml.includes("<stale>"), "non-stale should not include stale block");
	});

	test("includes stale block when stale=true", () => {
		const xml = renderCronFireXml({ ...baseOrigin, stale: true }, "p");
		assert.ok(xml.includes("<stale>true</stale>"));
	});

	test("renders recurring=false", () => {
		const xml = renderCronFireXml({ ...baseOrigin, recurring: false }, "p");
		assert.ok(xml.includes("<recurring>false</recurring>"));
	});

	test("escapes prompt special characters", () => {
		const xml = renderCronFireXml(baseOrigin, 'find <item> & "fix" it');
		assert.ok(xml.includes("&lt;item&gt;"));
		assert.ok(xml.includes("&amp;"));
		assert.ok(xml.includes("&quot;fix&quot;"));
		// Raw prompt should NOT appear.
		assert.ok(!xml.includes('<item>'), "raw <item> should not appear");
	});

	test("escapes cron expression if it contains special chars", () => {
		// Cron itself shouldn't normally contain HTML, but verify escaping
		// is applied uniformly for safety.
		const xml = renderCronFireXml(
			{ ...baseOrigin, cron: "<weird>" },
			"p",
		);
		assert.ok(xml.includes("&lt;weird&gt;"));
	});

	test("sub-agent mode instruction text contains fireId/jobId for CronReport", () => {
		const xml = renderCronFireXml(baseOrigin, "p");
		// Sub-agent mode instructions should reference the fireId and taskId
		// so the sub-agent knows what to report back.
		assert.ok(xml.includes("abcdef01"), "should include jobId");
		assert.ok(xml.includes("12345678"), "should include fireId");
		assert.ok(xml.toLowerCase().includes("sub-agent") || xml.toLowerCase().includes("subagent"));
	});

	test("main mode instruction text mentions main mode and fireId", () => {
		const xml = renderCronFireXml(
			{ ...baseOrigin, executionMode: "main" },
			"p",
		);
		assert.ok(xml.toLowerCase().includes("main"));
		assert.ok(xml.includes("abcdef01"));
		assert.ok(xml.includes("12345678"));
	});

	test("output is well-formed (one root cron_fire tag)", () => {
		const xml = renderCronFireXml(baseOrigin, "p");
		const openCount = (xml.match(/<cron_fire>/g) ?? []).length;
		const closeCount = (xml.match(/<\/cron_fire>/g) ?? []).length;
		assert.equal(openCount, 1);
		assert.equal(closeCount, 1);
	});
});