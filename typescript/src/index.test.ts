import { describe, expect, it } from "vitest";

import { hello } from "./index";

describe("hello", () => {
	it("returns the package greeting", () => {
		expect(hello()).toBe("hello kumofire/jobs!");
	});
});
