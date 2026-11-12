import { expect, test } from "bun:test";
import { reconcileAnnotationSlots } from "./annotationSlots";

interface Annotation {
	lineNumber: number;
}

const equal = (left: Annotation, right: Annotation) => left.lineNumber === right.lineNumber;

test("body-only review updates retain the geometry collection; moved or new slots replace it", () => {
	const previous = reconcileAnnotationSlots(
		[],
		[{ id: "comment", annotation: { lineNumber: 3 } }],
		equal,
	);
	const unchanged = reconcileAnnotationSlots(
		previous,
		[{ id: "comment", annotation: { lineNumber: 3 } }],
		equal,
	);
	expect(unchanged).toBe(previous);
	const moved = reconcileAnnotationSlots(
		previous,
		[{ id: "comment", annotation: { lineNumber: 4 } }],
		equal,
	);
	expect(moved).not.toBe(previous);
	expect(moved[0]?.annotation.lineNumber).toBe(4);
	const added = reconcileAnnotationSlots(
		previous,
		[
			{ id: "comment", annotation: { lineNumber: 3 } },
			{ id: "new", annotation: { lineNumber: 5 } },
		],
		equal,
	);
	expect(added).not.toBe(previous);
	expect(added[0]).toBe(previous[0]);
});

test("inserting a comment before an existing id appends a slot without changing the existing index", () => {
	const first = reconcileAnnotationSlots(
		[],
		[{ id: "existing", annotation: { lineNumber: 8 } }],
		equal,
	);
	const second = reconcileAnnotationSlots(
		first,
		[
			{ id: "inserted", annotation: { lineNumber: 2 } },
			{ id: "existing", annotation: { lineNumber: 8 } },
		],
		equal,
	);

	expect(second.map((slot) => slot.id)).toEqual(["existing", "inserted"]);
	expect(second.findIndex((slot) => slot.id === "existing")).toBe(0);
});

test("a removed comment keeps its tombstone slot and a new id appends after it", () => {
	const first = reconcileAnnotationSlots(
		[],
		[
			{ id: "removed", annotation: { lineNumber: 3 } },
			{ id: "kept", annotation: { lineNumber: 8 } },
		],
		equal,
	);
	const second = reconcileAnnotationSlots(
		first,
		[
			{ id: "kept", annotation: { lineNumber: 8 } },
			{ id: "new", annotation: { lineNumber: 10 } },
		],
		equal,
	);

	expect(second.map((slot) => slot.id)).toEqual(["removed", "kept", "new"]);
	expect(second[0]?.annotation.lineNumber).toBe(3);
});
