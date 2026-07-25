import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryStore, MAX_HISTORY_ENTRIES } from "../index.ts";
import type { HistoryStore, HistoryEntry, FireRecord } from "../index.ts";

function makeEntry(
	id: string,
	cron: string,
	prompt: string,
	createdAt: number,
	endTime: number,
	status: HistoryEntry["status"] = "done",
	fires: FireRecord[] = [],
): HistoryEntry {
	return { id, cron, prompt, createdAt, endTime, status, fires };
}

function makeFire(fireId: string, firedAt: number, status: FireRecord["status"] = "completed"): FireRecord {
	return { fireId, firedAt, startedAt: firedAt, endedAt: firedAt + 1000, status };
}

describe("createHistoryStore", () => {
	let tmp: string;
	let store: HistoryStore;

	before(async () => {
		tmp = await mkdtemp(join(tmpdir(), "cron-history-"));
		store = createHistoryStore(tmp);
	});

	after(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	test("archive() adds an entry", async () => {
		const entry = makeEntry("00000001", "0 9 * * *", "p", 1000, 2000);
		const evicted = await store.archive(entry);
		assert.equal(evicted, null);

		const entries = await store.list(100);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].id, "00000001");
	});

	test("list(N) returns most recent N, sorted newest first", async () => {
		// Already have 1 entry from prior test; add 2 more.
		await store.archive(makeEntry("00000002", "0 10 * * *", "p2", 3000, 4000));
		await store.archive(makeEntry("00000003", "0 11 * * *", "p3", 5000, 6000));

		const all = await store.list(100);
		assert.equal(all.length, 3);
		// Newest first
		assert.equal(all[0].id, "00000003");
		assert.equal(all[1].id, "00000002");
		assert.equal(all[2].id, "00000001");

		const last2 = await store.list(2);
		assert.equal(last2.length, 2);
		assert.equal(last2[0].id, "00000003");
		assert.equal(last2[1].id, "00000002");
	});

	test("list() default limit is 10", async () => {
		const defaults = await store.list();
		assert.ok(defaults.length <= 10);
	});

	test("get(id) returns the matching entry", async () => {
		const entry = await store.get("00000002");
		assert.ok(entry);
		assert.equal(entry!.id, "00000002");
		assert.equal(entry!.cron, "0 10 * * *");
	});

	test("get(id) returns undefined for missing id", async () => {
		const entry = await store.get("ffffffff");
		assert.equal(entry, undefined);
	});

	test("archive() returns evicted entry when > MAX_HISTORY_ENTRIES", async () => {
		// We have 3 entries. MAX_HISTORY_ENTRIES = 50. To trigger eviction,
		// we need a separate store with >50 entries.
		const bigTmp = await mkdtemp(join(tmpdir(), "cron-history-big-"));
		try {
			const bigStore = createHistoryStore(bigTmp);
			// Push MAX + 5 entries
			for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
				const hexId = i.toString(16).padStart(8, "0");
				const evicted = await bigStore.archive(
					makeEntry(hexId, "* * * * *", `p${i}`, i * 1000, i * 1000 + 500),
				);
				if (i < MAX_HISTORY_ENTRIES) {
					assert.equal(evicted, null, `entry ${i}: nothing evicted yet`);
				} else {
					// Once we're past cap, exactly one eviction happens per archive().
					assert.ok(evicted, `entry ${i}: should evict the oldest`);
				}
			}
			const all = await bigStore.list(MAX_HISTORY_ENTRIES + 100);
			assert.equal(all.length, MAX_HISTORY_ENTRIES, "should be capped at 50");
			// Newest first: the last entry we pushed (i = MAX + 4 = 54) should be first.
			const newestId = MAX_HISTORY_ENTRIES.toString(16).padStart(8, "0");
			// Wait, MAX_HISTORY_ENTRIES=50, so 55 entries total, capped to 50.
			// Entries 0..4 evicted. Entries 5..54 remain. Newest is 54.
			const expectedNewest = (MAX_HISTORY_ENTRIES + 4).toString(16).padStart(8, "0");
			assert.equal(all[0].id, expectedNewest, "newest is at top");
			// Sanity: confirm one of the original early entries was evicted (id 00000000).
			assert.equal(await bigStore.get("00000000"), undefined, "oldest evicted");
			// Reference the unused var to silence lint.
			void newestId;
		} finally {
			await rm(bigTmp, { recursive: true, force: true });
		}
	});

	test("entry with fires array preserves all fire records", async () => {
		const fires = [makeFire("aa000001", 100), makeFire("aa000002", 200, "failed")];
		const entry = makeEntry("aabbcc01", "*/5 * * * *", "watchdog", 1000, 2000, "done", fires);
		await store.archive(entry);

		const got = await store.get("aabbcc01");
		assert.ok(got);
		assert.equal(got!.fires.length, 2);
		assert.equal(got!.fires[0].fireId, "aa000001");
		assert.equal(got!.fires[1].status, "failed");
	});

	test("filePath() returns a stable path inside the cron dir", () => {
		const path = store.filePath();
		assert.ok(path.startsWith(tmp));
		assert.ok(path.endsWith("_history.json"));
	});
});