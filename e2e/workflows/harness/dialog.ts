import type {
	AskUserQuestionAnswer,
	AskUserQuestionItem,
	AskUserQuestionResult,
} from "@thinkrail/pi-ask-user-question/core";

export type DialogRung = "script" | "persona" | "fallback";

export function pickRecommended(questions: AskUserQuestionItem[]): AskUserQuestionResult {
	const answers: AskUserQuestionAnswer[] = questions.map((q, i) => ({
		questionIndex: i,
		question: q.question,
		kind: "option",
		answer: q.options[0]?.label ?? null,
	}));
	return { answers, cancelled: false };
}

export function skipAll(): AskUserQuestionResult {
	return { answers: [], cancelled: true };
}

export function parsePersonaReply(
	reply: string,
	questions: AskUserQuestionItem[],
): AskUserQuestionResult | null {
	const jsonMatch = reply.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	let parsed: { answers?: Array<{ questionIndex?: number; answer?: string }> };
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed.answers)) return null;
	const answers: AskUserQuestionAnswer[] = [];
	for (const entry of parsed.answers) {
		const index = entry.questionIndex;
		if (typeof index !== "number" || index < 0 || index >= questions.length) return null;
		const question = questions[index];
		if (!question) return null;
		const label = String(entry.answer ?? "");
		if (!question.options.some((o) => o.label === label)) return null;
		answers.push({
			questionIndex: index,
			question: question.question,
			kind: "option",
			answer: label,
		});
	}
	return answers.length > 0 ? { answers, cancelled: false } : null;
}
