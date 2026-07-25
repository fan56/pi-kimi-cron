import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPerIdJsonStore, isValidCronTask } from "../index.ts";
import type { PerIdJsonStore, CronTask } from "../index.ts";

const CRON_ID_REGEX = /^[0-9a-f]{8}$/;

function makeTask(id: string, cron: string, prompt: string): CronTask {
	return {
		id,
		cron,
		prompt,
		recurring: true,
		createdAt: 1700000000000,
		lastFiredAt: 0,
	};
}

describe("createPerIdJsonStore", () => {
	let tmp: string;
	let store: PerIdJsonStore<CronTask>;

	before(async () => {
		tmp = await mkdtemp(join(tmpdir(), "cron-json-"));
		store = createPerIdJsonStore<CronTask>({
			rootDir: tmp,
			subdir: "",
			idRegex: CRON_ID_REGEX,
			isValid: isValidCronTask,
			entityName: "cron job id",
		});
	});

	after(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	beforeEach(async () => {
		// Wipe directory contents between tests so each test starts fresh.
		try {
			const entries = await (await import("node:fs/promises")).readdir(tmp);
			await Promise.all(entries.map((e) => rm(join(tmp, e), { force: true })));
		} catch {
			// dir might not exist yet
		}
	});

	test("write + list round-trip", async () => {
		await store.write("abcdef01", makeTask("abcdef01", "* * * * *", "a"));
		await store.write("abcdef02", makeTask("abcdef02", "0 9 * * *", "b"));

		const list = await store.list();
		assert.equal(list.length, 2);
		const ids = list.map((t) => t.id).sort();
		assert.deepEqual(ids, ["abcdef01", "abcdef02"]);
	});

	test("write to invalid id throws", async () => {
		await assert.rejects(
			() => store.write("not-hex!", makeTask("not-hex!", "* * * * *", "x")),
			/Invalid cron job id/,
		);
		await assert.rejects(
			() => store.write("ABCDEF01", makeTask("ABCDEF01", "* * * * *", "x")),
			/Invalid cron job id/,
		);
		await assert.rejects(
			() => store.write("abcdef0", makeTask("abcdef0", "* * * * *", "x")), // 7 chars
			/Invalid cron job id/,
		);
	});

	test("remove deletes the file", async () => {
		await store.write("deadbeef", makeTask("deadbeef", "* * * * *", "x"));
		assert.equal((await store.list()).length, 1);

		await store.remove("deadbeef");
		assert.equal((await store.list()).length, 0);
	});

	test("remove on missing id is a no-op (does not throw)", async () => {
		// Should NOT throw ENOENT — the impl swallows it.
		await assert.doesNotReject(() => store.remove("00000000"));
	});

	test("remove with invalid id is silently ignored (no throw)", async () => {
		// invalid id regex → store.remove returns early without touching disk.
		await assert.doesNotReject(() => store.remove("not-hex!"));
	});

	test("list() on missing dir returns [] (does not throw)", async () => {
		// beforeEach wipes the dir, so list() against the empty tmp should
		// return [] without ENOENT being raised.
		const list = await store.list();
		assert.deepEqual(list, []);
	});

	test("corrupted JSON file is skipped (not loaded)", async () => {
		// Write a valid task first.
		await store.write("abcdef01", makeTask("abcdef01", "* * * * *", "ok"));
		// Now drop a corrupt file with a valid id-shaped name.
		await writeFile(join(tmp, "abcdef02.json"), "{not valid json", "utf-8");

		const list = await store.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].id, "abcdef01");
	});

	test("non-JSON files in dir are ignored", async () => {
		await store.write("abcdef01", makeTask("abcdef01", "* * * * *", "ok"));
		await writeFile(join(tmp, "README.md"), "# ignore me", "utf-8");
		await writeFile(join(tmp, "not-an-id.json"), "{}", "utf-8");

		const list = await store.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].id, "abcdef01");
	});

	test("file failing isValid() predicate is skipped", async () => {
		await store.write("abcdef01", makeTask("abcdef01", "* * * * *", "ok"));
		// Drop a syntactically valid JSON file with an invalid id (fails isValidCronTask).
		await writeFile(
			join(tmp, "abcdef02.json"),
			JSON.stringify({ id: "bad!", cron: "* * * * *", prompt: "x" }),
			"utf-8",
		);

		const list = await store.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].id, "abcdef01");
	});

	test("dir() returns the store's directory", () => {
		assert.equal(store.dir(), tmp);
	});

	test("subdir option places files in subdirectory", async () => {
		const subTmp = await mkdtemp(join(tmpdir(), "cron-sub-"));
		try {
			const subStore = createPerIdJsonStore<CronTask>({
				rootDir: subTmp,
				subdir: "tasks",
				idRegex: CRON_ID_REGEX,
				isValid: isValidCronTask,
				entityName: "cron job id",
			});
			await subStore.write("aabbcc01", makeTask("aabbcc01", "* * * * *", "x"));
			const list = await subStore.list();
			assert.equal(list.length, 1);
			assert.equal(list[0].id, "aabbcc01");
			assert.equal(subStore.dir(), join(subTmp, "tasks"));
		} finally {
			await rm(subTmp, { recursive: true, force: true });
		}
	});

	test("write + remove + re-write round-trip", async () => {
		await store.write("abcdef01", makeTask("abcdef01", "* * * * *", "v1"));
		await store.remove("abcdef01");
		await store.write("abcdef01", makeTask("abcdef01", "0 9 * * *", "v2"));

		const list = await store.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].cron, "0 9 * * *");
		assert.equal(list[0].prompt, "v2");
	});
});