import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCronExpression, parseField } from "../index.ts";

describe("parseField", () => {
	test("wildcard '*' produces all values in range", () => {
		const minute = parseField("*", 0);
		assert.equal(minute.size, 60);
		assert.ok(minute.has(0));
		assert.ok(minute.has(59));

		const hour = parseField("*", 1);
		assert.equal(hour.size, 24);
		assert.ok(hour.has(0));
		assert.ok(hour.has(23));

		const dom = parseField("*", 2);
		assert.equal(dom.size, 31);

		const month = parseField("*", 3);
		assert.equal(month.size, 12);

		const dow = parseField("*", 4);
		assert.equal(dow.size, 7);
	});

	test("'*/N' produces step values", () => {
		const step5 = parseField("*/5", 0);
		assert.equal(step5.size, 12);
		assert.deepEqual([...step5].sort((a, b) => a - b), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);

		const step10 = parseField("*/10", 1);
		assert.deepEqual([...step10].sort((a, b) => a - b), [0, 10, 20]);
	});

	test("'*/N' with explicit base range", () => {
		const result = parseField("10-30/5", 0);
		assert.deepEqual([...result].sort((a, b) => a - b), [10, 15, 20, 25, 30]);
	});

	test("range 'A-B' produces inclusive span", () => {
		const range = parseField("1-5", 0);
		assert.deepEqual([...range].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

		const dow = parseField("1-5", 4);
		assert.deepEqual([...dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
	});

	test("list 'A,B,C' produces discrete values", () => {
		const list = parseField("0,15,30,45", 0);
		assert.deepEqual([...list].sort((a, b) => a - b), [0, 15, 30, 45]);
	});

	test("rejects step < 1", () => {
		assert.throws(() => parseField("*/0", 0), /Invalid step/);
		assert.throws(() => parseField("*/-1", 0), /Invalid step/);
		assert.throws(() => parseField("*/abc", 0), /Invalid step/);
	});

	test("rejects out-of-range values", () => {
		assert.throws(() => parseField("60", 0), /out of range/);
		assert.throws(() => parseField("24", 1), /out of range/);
		assert.throws(() => parseField("32", 2), /out of range/);
		assert.throws(() => parseField("13", 3), /out of range/);
		assert.throws(() => parseField("7", 4), /out of range/);
	});

	test("rejects reversed range", () => {
		assert.throws(() => parseField("10-5", 0), /out of range/);
	});

	test("empty input produces no values and throws", () => {
		assert.throws(() => parseField("", 0), /no values/);
	});

	test("ignores empty parts in list", () => {
		const result = parseField("0,,15", 0);
		assert.deepEqual([...result].sort((a, b) => a - b), [0, 15]);
	});

	test("handles whitespace around commas", () => {
		const result = parseField(" 0 , 15 , 30 ", 0);
		assert.deepEqual([...result].sort((a, b) => a - b), [0, 15, 30]);
	});
});

describe("parseCronExpression", () => {
	test("valid 5-field expressions parse without error", () => {
		assert.doesNotThrow(() => parseCronExpression("* * * * *"));
		assert.doesNotThrow(() => parseCronExpression("0 9 * * 1-5"));
		assert.doesNotThrow(() => parseCronExpression("*/5 * * * *"));
		assert.doesNotThrow(() => parseCronExpression("0,15,30,45 * * * *"));
		assert.doesNotThrow(() => parseCronExpression("0 0 1 jan *"));
		assert.doesNotThrow(() => parseCronExpression("0 0 * * sun"));
	});

	test("returns ParsedCron with five Sets", () => {
		const parsed = parseCronExpression("0 9 * * 1-5");
		assert.ok(parsed.minutes instanceof Set);
		assert.ok(parsed.hours instanceof Set);
		assert.ok(parsed.daysOfMonth instanceof Set);
		assert.ok(parsed.months instanceof Set);
		assert.ok(parsed.daysOfWeek instanceof Set);
	});

	test("'0 9 * * 1-5' produces correct sets", () => {
		const parsed = parseCronExpression("0 9 * * 1-5");
		assert.deepEqual([...parsed.minutes], [0]);
		assert.deepEqual([...parsed.hours], [9]);
		assert.equal(parsed.daysOfMonth.size, 31);
		assert.equal(parsed.months.size, 12);
		assert.deepEqual([...parsed.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
	});

	test("month name 'jan' resolves to 1", () => {
		const parsed = parseCronExpression("0 0 1 jan *");
		assert.deepEqual([...parsed.months], [1]);
	});

	test("dow name 'sun' resolves to 0", () => {
		const parsed = parseCronExpression("0 0 * * sun");
		assert.deepEqual([...parsed.daysOfWeek], [0]);
	});

	test("all month names resolve correctly", () => {
		const expected = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
		for (let i = 0; i < expected.length; i++) {
			const parsed = parseCronExpression(`0 0 1 ${expected[i]} *`);
			assert.deepEqual([...parsed.months], [i + 1], `month ${expected[i]} should be ${i + 1}`);
		}
	});

	test("all dow names resolve correctly", () => {
		const expected = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
		for (let i = 0; i < expected.length; i++) {
			const parsed = parseCronExpression(`0 0 * * ${expected[i]}`);
			assert.deepEqual([...parsed.daysOfWeek], [i], `dow ${expected[i]} should be ${i}`);
		}
	});

	test("rejects wrong field count", () => {
		assert.throws(() => parseCronExpression("* * * *"), /exactly 5 fields/);
		assert.throws(() => parseCronExpression("* * * * * *"), /exactly 5 fields/);
		assert.throws(() => parseCronExpression(""), /exactly 5 fields/);
		assert.throws(() => parseCronExpression("    "), /exactly 5 fields/);
	});

	test("rejects out-of-range values", () => {
		assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
		assert.throws(() => parseCronExpression("* 24 * * *"), /out of range/);
		assert.throws(() => parseCronExpression("* * 32 * *"), /out of range/);
		assert.throws(() => parseCronExpression("* * * 13 *"), /out of range/);
		assert.throws(() => parseCronExpression("* * * * 7"), /out of range/);
	});

	test("rejects invalid step syntax", () => {
		assert.throws(() => parseCronExpression("*/0 * * * *"), /Invalid step/);
		assert.throws(() => parseCronExpression("*/abc * * * *"), /Invalid step/);
	});

	test("collapses whitespace between fields", () => {
		const parsed = parseCronExpression("0   9  *  *  1-5");
		assert.deepEqual([...parsed.minutes], [0]);
		assert.deepEqual([...parsed.hours], [9]);
		assert.deepEqual([...parsed.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
	});
});