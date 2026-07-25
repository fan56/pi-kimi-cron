import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isValidCronTask, isValidHistoryEntry } from "../index.ts";
import type { CronTask, HistoryEntry } from "../index.ts";

function makeValidCronTask(): CronTask {
	return {
		id: "abcdef01",
		cron: "0 9 * * 1-5",
		prompt: "test",
		recurring: true,
		createdAt: 1700000000000,
		lastFiredAt: 0,
	};
}

function makeValidHistoryEntry(): HistoryEntry {
	return {
		id: "abcdef01",
		cron: "0 9 * * 1-5",
		prompt: "test",
		recurring: true,
		createdAt: 1700000000000,
		endTime: 1700000060000,
		status: "done",
		fires: [],
	};
}

describe("isValidCronTask", () => {
	test("valid object passes", () => {
		assert.equal(isValidCronTask(makeValidCronTask()), true);
	});

	test("null / undefined / non-object fails", () => {
		assert.equal(isValidCronTask(null), false);
		assert.equal(isValidCronTask(undefined), false);
		assert.equal(isValidCronTask("string"), false);
		assert.equal(isValidCronTask(42), false);
		assert.equal(isValidCronTask([]), false);
	});

	test("missing id fails", () => {
		const t = makeValidCronTask();
		// @ts-expect-error: intentionally invalid
		delete t.id;
		assert.equal(isValidCronTask(t), false);
	});

	test("non-string id fails", () => {
		const t = { ...makeValidCronTask(), id: 12345 };
		assert.equal(isValidCronTask(t), false);
	});

	test("bad id format (not 8-hex) fails", () => {
		const t = { ...makeValidCronTask(), id: "not-hex!" };
		assert.equal(isValidCronTask(t), false);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "abc" }), false); // too short
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "ABCDEF01" }), false); // uppercase
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "abcdef0123" }), false); // too long
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "zzzzzzzz" }), false); // not hex
	});

	test("missing cron / prompt / createdAt / lastFiredAt fails", () => {
		const t = makeValidCronTask();
		// @ts-expect-error: intentionally invalid
		delete t.cron;
		assert.equal(isValidCronTask(t), false);

		const t2 = makeValidCronTask();
		// @ts-expect-error: intentionally invalid
		delete t2.prompt;
		assert.equal(isValidCronTask(t2), false);

		const t3 = makeValidCronTask();
		// @ts-expect-error: intentionally invalid
		delete t3.createdAt;
		assert.equal(isValidCronTask(t3), false);

		const t4 = makeValidCronTask();
		// @ts-expect-error: intentionally invalid
		delete t4.lastFiredAt;
		assert.equal(isValidCronTask(t4), false);
	});

	test("wrong types fail", () => {
		assert.equal(isValidCronTask({ ...makeValidCronTask(), cron: 123 }), false);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), prompt: null }), false);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), createdAt: "string" }), false);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), lastFiredAt: null }), false);
	});

	test("8-hex id in valid format passes", () => {
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "00000000" }), true);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "ffffffff" }), true);
		assert.equal(isValidCronTask({ ...makeValidCronTask(), id: "deadbeef" }), true);
	});

	test("optional fields can be omitted", () => {
		const t: CronTask = {
			id: "abcdef01",
			cron: "* * * * *",
			prompt: "x",
			createdAt: 0,
			lastFiredAt: 0,
		};
		assert.equal(isValidCronTask(t), true);
	});
});

describe("isValidHistoryEntry", () => {
	test("valid object passes", () => {
		assert.equal(isValidHistoryEntry(makeValidHistoryEntry()), true);
	});

	test("null / undefined / non-object fails", () => {
		assert.equal(isValidHistoryEntry(null), false);
		assert.equal(isValidHistoryEntry(undefined), false);
		assert.equal(isValidHistoryEntry("string"), false);
		assert.equal(isValidHistoryEntry(42), false);
		assert.equal(isValidHistoryEntry([]), false);
	});

	test("missing required fields fail", () => {
		const e = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e.id;
		assert.equal(isValidHistoryEntry(e), false);

		const e2 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e2.cron;
		assert.equal(isValidHistoryEntry(e2), false);

		const e3 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e3.prompt;
		assert.equal(isValidHistoryEntry(e3), false);

		const e4 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e4.createdAt;
		assert.equal(isValidHistoryEntry(e4), false);

		const e5 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e5.endTime;
		assert.equal(isValidHistoryEntry(e5), false);

		const e6 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e6.status;
		assert.equal(isValidHistoryEntry(e6), false);

		const e7 = makeValidHistoryEntry();
		// @ts-expect-error: intentionally invalid
		delete e7.fires;
		assert.equal(isValidHistoryEntry(e7), false);
	});

	test("bad id format fails", () => {
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), id: "x" }), false);
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), id: "ABCDEF01" }), false);
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), id: "" }), false);
	});

	test("wrong field types fail", () => {
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), cron: 1 }), false);
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), status: 99 }), false);
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), fires: "not-array" }), false);
		assert.equal(isValidHistoryEntry({ ...makeValidHistoryEntry(), createdAt: "now" }), false);
	});

	test("fires array can be empty", () => {
		const e = { ...makeValidHistoryEntry(), fires: [] };
		assert.equal(isValidHistoryEntry(e), true);
	});

	test("optional fields can be omitted", () => {
		const e: HistoryEntry = {
			id: "abcdef01",
			cron: "* * * * *",
			prompt: "x",
			createdAt: 0,
			endTime: 0,
			status: "done",
			fires: [],
		};
		assert.equal(isValidHistoryEntry(e), true);
	});
});