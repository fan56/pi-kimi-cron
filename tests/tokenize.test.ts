import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenizeArgs } from "../index.ts";

describe("tokenizeArgs", () => {
	test("simple unquoted args", () => {
		const tokens = tokenizeArgs("list create delete");
		assert.deepEqual(tokens, ["list", "create", "delete"]);
	});

	test("three tokens as specified", () => {
		const tokens = tokenizeArgs("list create delete");
		assert.equal(tokens.length, 3);
		assert.equal(tokens[0], "list");
		assert.equal(tokens[1], "create");
		assert.equal(tokens[2], "delete");
	});

	test("quoted args preserve internal spaces", () => {
		const tokens = tokenizeArgs('create "*/5 * * * *" "search news"');
		assert.equal(tokens.length, 3);
		assert.equal(tokens[0], "create");
		assert.equal(tokens[1], "*/5 * * * *");
		assert.equal(tokens[2], "search news");
	});

	test("flags mixed with quoted args", () => {
		const tokens = tokenizeArgs('create "*/5 * * * *" "prompt" --once');
		assert.equal(tokens.length, 4);
		assert.equal(tokens[0], "create");
		assert.equal(tokens[1], "*/5 * * * *");
		assert.equal(tokens[2], "prompt");
		assert.equal(tokens[3], "--once");
	});

	test("simple flag mix", () => {
		const tokens = tokenizeArgs("delete abc -r");
		assert.deepEqual(tokens, ["delete", "abc", "-r"]);
	});

	test("empty string returns empty array", () => {
		const tokens = tokenizeArgs("");
		assert.deepEqual(tokens, []);
	});

	test("whitespace-only string returns empty array", () => {
		const tokens = tokenizeArgs("   ");
		assert.deepEqual(tokens, []);
	});

	test("multiple spaces between tokens collapse", () => {
		const tokens = tokenizeArgs("list    create");
		assert.deepEqual(tokens, ["list", "create"]);
	});

	test("single arg with no spaces", () => {
		const tokens = tokenizeArgs("list");
		assert.deepEqual(tokens, ["list"]);
	});

	test("quote marks are consumed (not part of token)", () => {
		const tokens = tokenizeArgs('"hello"');
		assert.deepEqual(tokens, ["hello"]);
	});

	test("quoted text with trailing unquoted", () => {
		const tokens = tokenizeArgs('"first arg" second');
		assert.deepEqual(tokens, ["first arg", "second"]);
	});

	test("leading whitespace is skipped", () => {
		const tokens = tokenizeArgs("  list  ");
		assert.deepEqual(tokens, ["list"]);
	});

	test("unmatched opening quote keeps going until end", () => {
		// Edge case: opening quote never closes — all text becomes one token.
		const tokens = tokenizeArgs('"unterminated');
		assert.deepEqual(tokens, ["unterminated"]);
	});

	test("matched quotes around empty string produces nothing", () => {
		const tokens = tokenizeArgs('""');
		// Quotes toggle on then off; current is always empty.
		assert.deepEqual(tokens, []);
	});

	test("quotes nested? basic only — single level handles expected use", () => {
		// Single-level: "a b c" → one token.
		const tokens = tokenizeArgs('"a b c"');
		assert.deepEqual(tokens, ["a b c"]);
	});
});