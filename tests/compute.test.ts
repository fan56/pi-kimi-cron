import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCronExpression, computeNextCronRun } from "../index.ts";

describe("computeNextCronRun", () => {
	// NOTE: All Date math uses LOCAL time. The cron module's
	// computeNextCronRun() operates on local-time fields via Date setters
	// (setHours, setMinutes, etc.), so tests should construct baselines in
	// local time and compare against local-time expectations.

	test("'* * * * *' fires every minute", () => {
		const parsed = parseCronExpression("* * * * *");
		// Baseline = 18:14:28. Expected: skip to 18:15 (next matching minute).
		const baseline = new Date(2026, 6, 25, 18, 14, 28, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null, "should return a number");
		const nextDate = new Date(next!);
		assert.equal(nextDate.getFullYear(), 2026);
		assert.equal(nextDate.getMonth(), 6); // July
		assert.equal(nextDate.getDate(), 25);
		assert.equal(nextDate.getHours(), 18);
		assert.equal(nextDate.getMinutes(), 15);
		assert.equal(nextDate.getSeconds(), 0);
	});

	test("'MM * * * *' skips current minute when NOW is AT minute MM", () => {
		const parsed = parseCronExpression("30 * * * *");
		// Baseline is exactly 18:30:00 — the scheduler MUST skip to 19:30,
		// not fire immediately. This is the "skip current minute" behavior
		// implemented by `d.setMinutes(d.getMinutes() + 1)` at the top of
		// computeNextCronRun.
		const baseline = new Date(2026, 6, 25, 18, 30, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getHours(), 19, "should roll over to next hour");
		assert.equal(nextDate.getMinutes(), 30);
	});

	test("'MM * * * *' fires at next MM when NOW is BEFORE minute MM", () => {
		const parsed = parseCronExpression("30 * * * *");
		const baseline = new Date(2026, 6, 25, 18, 14, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getHours(), 18);
		assert.equal(nextDate.getMinutes(), 30);
	});

	test("daily '0 9 * * *' fires next 9:00 AM", () => {
		const parsed = parseCronExpression("0 9 * * *");
		// Baseline is 2026-07-25T07:00:00 — same day, before 9 AM.
		const baseline = new Date(2026, 6, 25, 7, 0, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getFullYear(), 2026);
		assert.equal(nextDate.getMonth(), 6);
		assert.equal(nextDate.getDate(), 25);
		assert.equal(nextDate.getHours(), 9);
		assert.equal(nextDate.getMinutes(), 0);
	});

	test("daily '0 9 * * *' rolls to NEXT day when NOW is past 9 AM", () => {
		const parsed = parseCronExpression("0 9 * * *");
		const baseline = new Date(2026, 6, 25, 10, 0, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getDate(), 26, "should roll to July 26");
		assert.equal(nextDate.getHours(), 9);
	});

	test("weekday '0 9 * * 1-5' rolls over weekend", () => {
		const parsed = parseCronExpression("0 9 * * 1-5");
		// 2026-07-25 is a Saturday (DOW=6, outside 1-5).
		// Baseline is Saturday 10:00 → next fire is Monday 2026-07-27 09:00.
		const baseline = new Date(2026, 6, 25, 10, 0, 0, 0).getTime();
		assert.equal(new Date(baseline).getDay(), 6, "sanity: baseline is Saturday");
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getDay(), 1, "should be Monday");
		assert.equal(nextDate.getDate(), 27);
		assert.equal(nextDate.getHours(), 9);
	});

	test("Feb 30 (impossible) returns null within maxYears", () => {
		const parsed = parseCronExpression("0 0 30 2 *");
		const baseline = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.equal(next, null, "Feb 30 should never match → null");
	});

	test("'*/5 * * * *' picks next 5-minute boundary", () => {
		const parsed = parseCronExpression("*/5 * * * *");
		const baseline = new Date(2026, 6, 25, 18, 13, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getMinutes(), 15);
	});

	test("'0 0 1 jan *' picks next Jan 1 at 00:00", () => {
		const parsed = parseCronExpression("0 0 1 jan *");
		const baseline = new Date(2026, 6, 25, 0, 0, 0, 0).getTime();
		const next = computeNextCronRun(parsed, baseline);
		assert.ok(next !== null);
		const nextDate = new Date(next!);
		assert.equal(nextDate.getMonth(), 0, "January");
		assert.equal(nextDate.getDate(), 1);
		assert.equal(nextDate.getHours(), 0);
		assert.equal(nextDate.getMinutes(), 0);
	});

	// DST NOTE: computeNextCronRun() uses Date setters in local time. In a
	// DST transition hour (spring forward / fall back), the engine may
	// either skip the missing local hour or hit the duplicated hour twice.
	// This is platform-dependent and not exercised here. If your tests run
	// in a TZ with DST, expect ±1h fuzz on boundary cases.
	test("DST: skipped (platform-dependent, not asserted)", () => {
		// Placeholder to document the gap.
	});
});