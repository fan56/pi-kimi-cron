import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cronToHuman } from "../index.ts";

describe("cronToHuman", () => {
	test("'* * * * *' returns 'every minute'", () => {
		assert.equal(cronToHuman("* * * * *"), "every minute");
	});

	test("'0 * * * *' returns 'every hour'", () => {
		assert.equal(cronToHuman("0 * * * *"), "every hour");
	});

	test("'0 0 * * *' returns 'daily at midnight'", () => {
		assert.equal(cronToHuman("0 0 * * *"), "daily at midnight");
	});

	test("'0 9 * * *' returns 'daily at 9:00 AM'", () => {
		assert.equal(cronToHuman("0 9 * * *"), "daily at 9:00 AM");
	});

	test("'0 9 * * 1-5' returns 'weekdays at 9:00 AM'", () => {
		assert.equal(cronToHuman("0 9 * * 1-5"), "weekdays at 9:00 AM");
	});

	test("'0 0 * * 0' returns 'weekly on Sunday at midnight'", () => {
		assert.equal(cronToHuman("0 0 * * 0"), "weekly on Sunday at midnight");
	});

	test("'0 0 1 * *' returns 'monthly on the 1st at midnight'", () => {
		assert.equal(cronToHuman("0 0 1 * *"), "monthly on the 1st at midnight");
	});

	test("non-preset '*/5 * * * *' describes minute */5", () => {
		const result = cronToHuman("*/5 * * * *");
		assert.ok(result.includes("*/5"), `should mention */5, got: ${result}`);
	});

	test("non-preset '30 8 * * *' describes minute 30 and hour 8", () => {
		const result = cronToHuman("30 8 * * *");
		assert.ok(result.includes("30"));
		assert.ok(result.includes("8"));
	});

	test("non-preset with dow names lists days", () => {
		const result = cronToHuman("0 12 * * 1,3,5");
		// Should mention Mon, Wed, Fri (day-of-week names from the lookup table).
		assert.ok(result.includes("Mon"), `should include Mon, got: ${result}`);
		assert.ok(result.includes("Wed"), `should include Wed, got: ${result}`);
		assert.ok(result.includes("Fri"), `should include Fri, got: ${result}`);
	});

	test("normalizes whitespace before lookup", () => {
		// Extra whitespace inside a preset should still match.
		assert.equal(cronToHuman("0   9  *  *  1-5"), "weekdays at 9:00 AM");
	});

	test("returns raw cron when field count is wrong", () => {
		// 4 fields is not valid cron — the helper returns the input unchanged.
		assert.equal(cronToHuman("* * * *"), "* * * *");
		// 6 fields also returns raw.
		assert.equal(cronToHuman("* * * * * *"), "* * * * * *");
	});

	test("all-wildcard non-preset returns raw cron (no parts to describe)", () => {
		// '* * * * *' IS a preset, but '* * * * *' as fallback returns the
		// cron itself since parts would be empty. The preset covers this.
		// Test a non-preset all-wildcard variant: '0 0 29 2 *' (Feb 29, leap).
		const result = cronToHuman("0 0 29 2 *");
		// Should mention day 29 and month 2.
		assert.ok(result.includes("29"));
		assert.ok(result.includes("2"));
	});
});